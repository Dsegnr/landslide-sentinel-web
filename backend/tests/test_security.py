"""安全自查（对自家系统的攻击式检查）。

把常见攻击手法逐条打一遍，确认系统能挡住：未授权访问 / JWT 篡改 / alg=none 伪造 /
越权提权 / 登录爆破 / 上传绕过 / SQL 注入 / 存储型 XSS 载荷 / 目录穿越 / CORS 越界 /
敏感信息泄露 / 安全响应头。**这不是专业渗透测试**，是"自家系统的授权自查"。

注意：攻击样本**在运行时拼接**（见 `_p()`），不在源码里留字面特征串——
否则本机安全软件会把这个文件当恶意样本直接隔离（真实踩过）。

运行：cd web/backend && python tests/test_security.py
"""
from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from config import settings  # noqa: E402
from database import AuditLog, SessionLocal, init_db  # noqa: E402
from services import security  # noqa: E402


def _p(*parts: str) -> str:
    """运行时拼出攻击样本（避免源码含字面特征串被安全软件隔离）。"""
    return "".join(parts)


SQLI = [
    _p("' OR ", "1=1", "--"),
    _p("'; DROP ", "TABLE alerts; --"),
    _p("1' UNION ", "SELECT * FROM users", "--"),
]
XSS = [
    _p("<scr", "ipt>alert(1)</scr", "ipt>"),
    _p('"><img src=x ', "onerror=alert(1)>"),
]
SHELL_BODY = _p("<?p", "hp system($_GET['c']); ?", ">")
SVG_BODY = _p("<svg ", "onload=alert(1)", ">")

PROTECTED = [
    ("GET", "/api/devices"), ("GET", "/api/alerts"), ("GET", "/api/records"),
    ("GET", "/api/points"), ("GET", "/api/map/overview"),
    ("GET", "/api/sensors/slope-node-01"), ("GET", "/api/predict/slope-node-01"),
    ("GET", "/api/auth/me"), ("GET", "/api/admin/overview"), ("GET", "/api/admin/audit"),
    ("POST", "/api/alerts/1/ack"), ("POST", "/api/points"), ("DELETE", "/api/points/1"),
]


def test_unauthorized(client: TestClient) -> None:
    for method, path in PROTECTED:
        res = client.request(method, path, json={} if method == "POST" else None)
        assert res.status_code == 401, f"{method} {path} 未登录竟然放行：{res.status_code}"
    assert client.get("/api/health").status_code == 200
    print(f"未授权访问 -> {len(PROTECTED)} 个接口全部 401；/api/health 保持公开")


def test_jwt_tampering(client: TestClient) -> None:
    token = authed_client(client).token
    head, payload, sig = token.split(".")

    def b64(obj: dict) -> str:
        raw = json.dumps(obj, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    forged = b64({"sub": "attacker", "role": "admin", "exp": 9999999999})
    cases = {
        "改 payload": f"{head}.{forged}.{sig}",
        "换签名": f"{head}.{payload}.{'a' * 43}",
        "alg=none": f"{b64({'alg': 'none', 'typ': 'JWT'})}.{forged}.",
        "空 token": "",
    }
    for name, bad in cases.items():
        res = client.get("/api/admin/overview", headers={"Authorization": f"Bearer {bad}"})
        assert res.status_code in (401, 403), f"{name} 竟然通过：{res.status_code}"
    print(f"JWT 篡改 -> {len(cases)} 种伪造方式全部被拒（401/403）")


def test_privilege_escalation(client, admin) -> None:
    """普通用户不能写：新增/修改/删除点位、管理接口。"""
    point = admin.post("/api/points",
                       json={"name": "越权靶点", "lon": 110, "lat": 30}).json()["point"]
    for method, path, body in (
        ("POST", "/api/points", {"name": "x", "lon": 110, "lat": 30}),
        ("PATCH", f"/api/points/{point['id']}", {"weight": 3.0}),
        ("DELETE", f"/api/points/{point['id']}", None),
    ):
        res = client.request(method, path, json=body)
        assert res.status_code == 403, f"普通用户 {method} {path} 应为 403，实际 {res.status_code}"
    assert client.get("/api/admin/overview").status_code == 403
    print("越权（提权）-> 新增/修改/删除点位全部 403，管理接口 403")


def test_upload_bypass(admin) -> None:
    """上传绕过：脚本改后缀、SVG、超大文件、路径穿越文件名。"""
    cases = [
        ("shell.php", SHELL_BODY.encode(), "image/png"),
        ("fake.png", b"hostile-not-an-image", "image/png"),      # 内容不是图片
        ("evil.svg", SVG_BODY.encode(), "image/svg+xml"),        # 扩展名不在白名单
        ("big.png", b"\x89PNG\r\n\x1a\n" + b"0" * (9 * 1024 * 1024), "image/png"),
    ]
    for name, content, ctype in cases:
        res = admin.post("/api/records", data={"point_name": "上传测试"},
                         files={"photo": (name, io.BytesIO(content), ctype)})
        assert res.status_code == 422, f"{name} 应被拒，实际 {res.status_code}"

    png = b"\x89PNG\r\n\x1a\n" + b"x" * 64
    res = admin.post("/api/records", data={"point_name": "穿越测试"},
                     files={"photo": ("../../../../tmp/evil.png", io.BytesIO(png), "image/png")})
    assert res.status_code == 200, res.text
    url = res.json()["record"]["photo_url"]
    assert url.startswith("/uploads/") and ".." not in url, url
    saved = Path(settings.upload_dir) / Path(url).name
    assert saved.exists() and saved.parent == Path(settings.upload_dir), saved
    print("上传绕过 -> 脚本/SVG/超大/内容不符全 422；穿越文件名被 UUID 化、落盘位置正确")


def test_injection_payloads(client, admin) -> None:
    """SQL 注入与存储型 XSS 载荷：必须按纯文本处理，不能 500、不能改查询语义。"""
    for p in SQLI + XSS:
        bad_login = client.post("/api/auth/login", json={"username": p, "password": p})
        assert bad_login.status_code in (401, 429, 422), f"注入载荷异常状态：{bad_login.status_code}"
        created = admin.post("/api/points", json={"name": p[:60], "lon": 110, "lat": 30})
        assert created.status_code == 200, created.text
        assert created.json()["point"]["name"] == p[:60], "名称被改写，说明做了危险的字符串处理"
    assert client.get("/api/alerts").status_code == 200          # 数据表没被删
    print(f"注入/XSS 载荷 -> {len(SQLI) + len(XSS)} 组按纯文本处理（无 500、无表被删、无脚本回显）")


def test_path_and_cors(client: TestClient) -> None:
    for path in ["/uploads/../backend/.env", "/media/../backend/config.py",
                 "/geo/../../backend/.env"]:
        res = client.get(path)
        assert res.status_code in (400, 403, 404), f"{path} 竟然可读：{res.status_code}"
    res = client.get("/api/health", headers={"Origin": "http://evil.example.com"})
    allow = res.headers.get("access-control-allow-origin", "")
    assert "evil.example.com" not in allow, f"CORS 放行了非白名单来源：{allow}"
    print(f"目录穿越 -> 3 种路径全部拒绝；CORS -> 非白名单来源未放行（allow-origin: {allow or '无'}）")


def test_headers_and_leak(client: TestClient) -> None:
    res = client.get("/api/health")
    for header, expect in (("X-Content-Type-Options", "nosniff"),
                           ("X-Frame-Options", "DENY"),
                           ("Referrer-Policy", "no-referrer")):
        assert res.headers.get(header) == expect, f"{header} 缺失：{res.headers.get(header)}"
    csp = res.headers.get("Content-Security-Policy", "")
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp, csp
    body = res.text.lower()
    for secret in ("admin_key", settings.admin_key.lower(),
                   "jwt_secret", settings.jwt_secret.lower(),
                   settings.app_password.lower()):
        assert secret not in body, f"/api/health 泄露敏感信息：{secret[:12]}"
    print("安全头 -> nosniff / DENY / no-referrer / CSP(script-src self) 齐备；健康检查不泄露凭据")


def test_brute_force(client: TestClient) -> None:
    """登录爆破：连续失败必须限流（429 + Retry-After），并留下审计。"""
    security.reset_state()
    codes = []
    for _ in range(security.MAX_FAILURES + 1):
        res = client.post("/api/auth/login", json={"username": "monitor", "password": "wrong"})
        codes.append(res.status_code)
    assert codes[-1] == 429, f"连续失败后应触发限流，实际 {codes}"
    last = client.post("/api/auth/login", json={"username": "monitor", "password": "wrong"})
    assert last.headers.get("Retry-After"), "429 应带 Retry-After"

    db = SessionLocal()
    try:
        locked = db.query(AuditLog).filter(AuditLog.action == "login_locked").count()
    finally:
        db.close()
    assert locked >= 1, "触发锁定应写审计"
    print(f"登录爆破 -> 第 {len(codes)} 次返回 429（Retry-After={last.headers['Retry-After']}s），"
          f"已写 login_locked 审计")

    ok = client.post("/api/auth/login",
                     json={"username": "monitor", "password": settings.app_password})
    assert ok.status_code == 429, "锁定期内正确密码也应被限流"
    security.reset_state()
    assert client.post("/api/auth/login",
                       json={"username": "monitor",
                             "password": settings.app_password}).status_code == 200
    print("限流语义 -> 锁定期内正确密码同样 429；重置后恢复正常登录")


def test_rate_limit_is_per_client() -> None:
    """限流必须按"真实来源"分开统计。

    线上是 cloudflared 隧道：所有外部请求在服务端都来自 127.0.0.1。
    如果按 socket 地址限流，一个人输错密码会把所有人锁掉（实测踩到过）。
    这里验证：隧道场景下不同 CF-Connecting-IP 之间互不影响。
    """
    # 关键：必须用"回环来源"构造客户端，才等价于线上"经 cloudflared 隧道"的场景
    from main import app
    security.reset_state()
    with TestClient(app, client=("127.0.0.1", 50000)) as tunnel:
        evil = {"CF-Connecting-IP": "203.0.113.9"}
        for _ in range(security.MAX_FAILURES):
            tunnel.post("/api/auth/login", json={"username": "monitor", "password": "wrong"},
                        headers=evil)
        assert tunnel.post("/api/auth/login",
                           json={"username": "monitor", "password": "wrong"},
                           headers=evil).status_code == 429, "该来源应被锁定"

        # 另一个来源（别的用户）不该被连坐
        other = tunnel.post("/api/auth/login",
                            json={"username": "monitor", "password": settings.app_password},
                            headers={"CF-Connecting-IP": "198.51.100.7"})
        assert other.status_code == 200, f"别的来源被连坐锁定了：{other.status_code}"
    security.reset_state()
    print("限流隔离 -> 隧道场景下按 CF-Connecting-IP 分别计数，A 被锁不影响 B 登录")


def main() -> None:
    init_db()
    security.reset_state()
    from main import app
    with TestClient(app) as raw:
        user = authed_client(raw)
        admin = authed_client(raw, admin=True)
        test_unauthorized(raw)
        test_jwt_tampering(raw)
        test_privilege_escalation(user, admin)
        test_upload_bypass(admin)
        test_injection_payloads(user, admin)
        test_path_and_cors(raw)
        test_headers_and_leak(raw)
        test_brute_force(raw)
        test_rate_limit_is_per_client()
    print("安全自查通过（限流/鉴权/越权/上传/注入/穿越/CORS/安全头）")


if __name__ == "__main__":
    main()
