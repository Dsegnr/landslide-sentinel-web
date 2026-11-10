"""P8 鉴权测试：普通用户登录 + 管理人员密钥入口 + 接口保护。

三种身份要分清（也是队伍定的口径：不做三角色）：
  * 未登录      -> 受保护接口 401、WebSocket 直接 1008 关闭
  * 普通用户    -> 只能读（大屏），确认告警 403
  * 管理人员    -> 密钥换 admin token，可确认告警、看审计与运维概览

运行：cd web/backend && python tests/test_auth.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from config import settings  # noqa: E402
from database import Alert, SessionLocal, init_db  # noqa: E402


def test_login(client: TestClient) -> None:
    # 1) 密码错 -> 401
    bad = client.post("/api/auth/login",
                      json={"username": settings.app_username, "password": "wrong-password"})
    assert bad.status_code == 401, bad.text
    # 2) 账号不存在 -> 401（不泄露"用户是否存在"）
    ghost = client.post("/api/auth/login", json={"username": "nobody", "password": "x"})
    assert ghost.status_code == 401, ghost.text
    # 3) 正常登录
    ok = client.post("/api/auth/login",
                     json={"username": settings.app_username, "password": settings.app_password})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["role"] == "user" and body["token"] and body["expires_in"] > 0, body
    print(f"普通用户登录 -> role={body['role']} token 长度={len(body['token'])}")

    # 4) /me 回显身份
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200 and me.json()["role"] == "user", me.text


def test_admin_key(client: TestClient) -> None:
    bad = client.post("/api/auth/admin", json={"key": "not-the-key"})
    assert bad.status_code == 401, bad.text
    ok = client.post("/api/auth/admin", json={"key": settings.admin_key})
    assert ok.status_code == 200, ok.text
    assert ok.json()["role"] == "admin" and ok.json()["token"], ok.text
    print("管理人员密钥入口 -> 401/200 均符合预期")


def test_protection(client: TestClient) -> None:
    """未登录必须被挡住；普通用户能读、不能写。"""
    for path in ("/api/devices", "/api/alerts", "/api/sensors/slope-node-01",
                 "/api/predict/slope-node-01"):
        res = client.get(path)
        assert res.status_code == 401, f"{path} 未登录竟然放行：{res.status_code}"
    assert client.get("/api/health").status_code == 200, "健康检查应保持公开"

    db = SessionLocal()
    try:
        row = Alert(device_id="auth-probe", ts=datetime.now(timezone.utc).replace(tzinfo=None),
                    level=3, stage="高度预警", reason="鉴权测试", status="open")
        db.add(row)
        db.commit()
        db.refresh(row)
        alert_id = int(row.id)
    finally:
        db.close()

    user = authed_client(client)
    assert user.get("/api/devices").status_code == 200, "普通用户应能读大屏数据"
    forbidden = user.post(f"/api/alerts/{alert_id}/ack")
    assert forbidden.status_code == 403, f"普通用户不应能确认告警：{forbidden.status_code}"

    admin = authed_client(client, admin=True)
    allowed = admin.post(f"/api/alerts/{alert_id}/ack")
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["by"] == "admin", allowed.text

    overview = admin.get("/api/admin/overview")
    assert overview.status_code == 200, overview.text
    data = overview.json()
    assert data["counts"]["alerts"] >= 1 and data["operator"] == "admin", data
    audit = admin.get("/api/admin/audit").json()
    assert audit["count"] >= 1, "确认告警后审计里应该有记录"
    acked = [a for a in audit["items"] if a["action"] == "alert_acked"]
    assert acked, f"确认动作没有写审计：{[a['action'] for a in audit['items']]}"
    assert acked[0]["by"] == "admin", acked[0]
    assert user.get("/api/admin/overview").status_code == 403, "普通用户不得进管理后台"
    print(f"接口保护 -> 未登录 401、普通用户读 OK/写 403、管理员确认告警 OK（by={allowed.json()['by']}，"
          f"审计 {acked[0]['action']} 已留痕）")


def test_ws_requires_token(client: TestClient) -> None:
    """WebSocket 不带 token 必须被拒（且不泄露任何数据）。"""
    import starlette.websockets as sw

    try:
        with client.websocket_connect("/ws/stream") as ws:
            ws.receive_json()
        raise AssertionError("未登录的 WebSocket 竟然连上了")
    except sw.WebSocketDisconnect as exc:
        assert exc.code == 1008, f"应以 1008 关闭，实际 {exc.code}"

    user = authed_client(client)
    with user.websocket_connect(user.url_with_token("/ws/stream")) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello", hello
    print("WebSocket -> 无 token 1008 拒绝；带 token 正常收到 hello")


def main() -> None:
    init_db()
    from main import app
    with TestClient(app) as client:
        test_login(client)
        test_admin_key(client)
        test_protection(client)
        test_ws_requires_token(client)
    print("P8 鉴权测试通过")


if __name__ == "__main__":
    main()
