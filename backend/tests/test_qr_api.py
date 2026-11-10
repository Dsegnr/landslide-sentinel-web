"""二维码接口契约测试：/api/qr.svg。

覆盖：鉴权、SVG 内容类型、尺寸可调、超长文本被拒（防止被当免费二维码服务刷）。

运行：cd web/backend && python tests/test_qr_api.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402


def test_auth_required(raw: TestClient) -> None:
    code = raw.get("/api/qr.svg", params={"text": "https://example.test"}).status_code
    assert code == 401, f"未登录应 401，实际 {code}"
    print("[OK] 未登录 → 401")


def test_svg_output(client) -> None:
    url = "https://played-registered-atlanta-festival.trycloudflare.com"
    r = client.get("/api/qr.svg", params={"text": url})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/svg+xml"), r.headers
    body = r.text
    # 带 xmldecl 才算完整的独立 SVG 文档（<img> 按独立文档解析）
    assert body.lstrip().startswith("<?xml"), body[:60]
    assert "<svg" in body, body[:80]
    assert "</svg>" in body
    # **必须带 xmlns**：`<img src="...svg">` 按独立文档解析，缺了它浏览器会拒绝渲染
    # （接口 200、字节正常，但 img.naturalWidth=0 —— 实测踩过）
    assert 'xmlns="http://www.w3.org/2000/svg"' in body, "缺 xmlns，<img> 渲染不出来"
    # 地址可能变，不能让浏览器拿旧二维码
    assert "no-store" in r.headers.get("cache-control", ""), r.headers
    print(f"[OK] 返回 SVG（{len(body)} 字节，{r.headers['cache-control']}）")


def test_scale_changes_size(client) -> None:
    small = client.get("/api/qr.svg", params={"text": "x", "scale": 2}).text
    big = client.get("/api/qr.svg", params={"text": "x", "scale": 12}).text
    assert len(big) > len(small) or big != small, "scale 应影响输出尺寸"
    print("[OK] scale 参数生效（投影上可以放大）")


def test_too_long_rejected(client) -> None:
    r = client.get("/api/qr.svg", params={"text": "a" * 2000})
    assert r.status_code == 422, f"超长文本应 422，实际 {r.status_code}"
    print("[OK] 超长文本 → 422（不会被当成免费二维码生成服务）")


def test_self_qr_is_public_and_zero_input(raw: TestClient) -> None:
    """自助二维码：**不需要登录**（登录页没有登录态），且**不接受任何文本参数**。

    如果这里退化成"公开 + 可传 text"，就成了对外的免费二维码生成服务。
    """
    r = raw.get("/api/qr/self.svg")
    assert r.status_code == 200, f"登录页要用的自助二维码必须公开可访问，实际 {r.status_code}"
    assert r.headers["content-type"].startswith("image/svg+xml")
    assert r.text.lstrip().startswith("<?xml") and "<svg" in r.text
    assert 'xmlns="http://www.w3.org/2000/svg"' in r.text, "缺 xmlns，<img> 渲染不出来"
    # 传了 text 也不该被采用：端点是零输入的
    r2 = raw.get("/api/qr/self.svg", params={"text": "https://evil.example"})
    assert r2.status_code == 200 and r2.text == r.text, "自助端点不应接受外部文本"
    print("[OK] 自助二维码公开可访问、且零输入（不接受 text 参数）")


def main() -> None:
    from main import app
    with TestClient(app) as raw:
        client = authed_client(raw)
        test_auth_required(raw)
        test_svg_output(client)
        test_scale_changes_size(client)
        test_too_long_rejected(client)
        test_self_qr_is_public_and_zero_input(raw)
    print("\nP16 二维码接口测试通过")


if __name__ == "__main__":
    main()
