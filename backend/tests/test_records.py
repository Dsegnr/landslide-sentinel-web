"""现场记录测试：落库 + 照片落盘（原版这块是内存 + blob，刷新就丢）。

覆盖：普通用户只读、管理人员可建、照片真的落盘并能回读、非法格式被拒。

运行：cd web/backend && python tests/test_records.py
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from config import settings  # noqa: E402
from database import init_db  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"sentinel-test-photo" * 4   # 内容不重要，接口按扩展名校验


def test_records(client, admin) -> None:
    assert client.get("/api/records").status_code == 200, "普通用户应能看记录列表"

    denied = client.post("/api/records", data={"point_name": "滑坡点X", "level": "中度"})
    assert denied.status_code == 403, f"普通用户不该能新增记录：{denied.status_code}"

    created = admin.post(
        "/api/records",
        data={"point_name": "白家包 ZD1", "level": "重度", "note": "坡面出现新裂缝",
              "device_id": "slope-node-01"},
        files={"photo": ("site.png", io.BytesIO(PNG), "image/png")},
    )
    assert created.status_code == 200, created.text
    rec = created.json()["record"]
    assert rec["point_name"] == "白家包 ZD1" and rec["level"] == "重度", rec
    assert rec["created_by"] == "admin" and rec["photo_url"], rec
    print(f"新增记录 -> id={rec['id']} {rec['point_name']} {rec['level']} by={rec['created_by']}")

    photo_path = Path(settings.upload_dir) / Path(rec["photo_url"]).name
    assert photo_path.exists(), f"照片没落盘：{photo_path}"
    fetched = client.get(rec["photo_url"])
    assert fetched.status_code == 200 and fetched.content == PNG, "照片回读不一致"
    print(f"照片落盘 -> {photo_path.name}（{photo_path.stat().st_size} 字节），HTTP 回读一致")

    listing = client.get("/api/records").json()
    assert any(x["id"] == rec["id"] for x in listing["items"]), listing

    bad = admin.post("/api/records", data={"point_name": "X"},
                     files={"photo": ("evil.exe", io.BytesIO(b"MZ"), "application/octet-stream")})
    assert bad.status_code == 422, bad.text
    print("非法照片格式被拒 -> 422")

    deleted = admin.delete(f"/api/records/{rec['id']}")
    assert deleted.status_code == 200, deleted.text
    assert photo_path.exists(), "删记录不应删除照片文件（现场证据留存）"
    print("删除记录 -> 照片文件保留（历史留存）")


def main() -> None:
    init_db()
    from main import app
    with TestClient(app) as raw:
        test_records(authed_client(raw), authed_client(raw, admin=True))
    print("现场记录测试通过")


if __name__ == "__main__":
    main()
