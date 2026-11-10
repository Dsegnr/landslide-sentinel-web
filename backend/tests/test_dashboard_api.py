"""P5 契约测试：大屏依赖的三个接口。

  1. `GET /api/devices` —— 设备列表 + 最新读数 + 最新预警 + 未处理告警数；
  2. `GET /api/sensors/{id}` —— 历史读数序列 + 预警等级演进；
  3. `GET /api/alerts` / `POST /api/alerts/{id}/ack` —— 告警台账与确认。

断言的是**契约**（字段齐备、类型正确、口径一致），不是某一组具体数值，
因此换数据集、换设备都不会误报。

运行：cd web/backend && python tests/test_dashboard_api.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, ensure_min_series, setup  # noqa: E402

setup(__file__)          # 必须在 import database / services 之前

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from services.device_manager import DEFAULT_DEVICES  # noqa: E402
from services.timeutil import iso_utc  # noqa: E402

DEVICE = next(iter(DEFAULT_DEVICES))


def test_devices(client: TestClient) -> None:
    r = client.get("/api/devices")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] >= 1 and len(body["items"]) == body["count"]
    assert "tuya_configured" in body
    item = body["items"][0]
    for key in ("device_id", "name", "mode", "has_level", "is_demo", "latest_ts",
                "reading", "prediction", "open_alerts", "acked_alerts",
                "station_id", "level_m", "level_days"):
        assert key in item, f"缺少字段 {key}"
    assert item["mode"] in ("full", "sentinel_only")
    assert isinstance(item["is_demo"], bool)
    if item["reading"]:
        assert set(item["reading"]) == {"R", "P", "T", "H", "RN", "RNM", "S", "D",
                                        "DIST"}
    if item["prediction"]:
        assert item["prediction"]["combined_level"] in (0, 1, 2, 3, 4)
        assert item["prediction"]["ts"].endswith("Z"), "时间戳必须带时区标识"
    print(f"/api/devices -> {body['count']} 台，首台 {item['device_id']} "
          f"mode={item['mode']} 未处理告警={item['open_alerts']}")


def test_is_demo_follows_db_mark(client: TestClient) -> None:
    """`is_demo` 必须来自 devices 表的**持久标记**，而不是内存注册表的默认值。

    回归背景：`DeviceInfo.is_virtual` 默认 True，早先 `/api/devices` 直接读它，
    结果硬件直连设备（devices.is_virtual=0）也被标成"演示"。
    这里把口径钉死：真硬件 → False；从没推送过硬件的设备 → True。
    与 `services/ingest.py:is_hardware_device` 必须一致。
    """
    from database import Device, SessionLocal, init_db

    init_db()
    db = SessionLocal()

    def _row():
        return db.execute(select(Device).where(Device.device_id == DEVICE)).scalars().first()

    def _is_demo() -> bool:
        body = client.get("/api/devices").json()
        return next(i for i in body["items"] if i["device_id"] == DEVICE)["is_demo"]

    original = _row()
    had_row = original is not None
    prev_virtual = bool(original.is_virtual) if had_row else None
    try:
        if had_row:
            original.is_virtual = False
        else:
            db.add(Device(device_id=DEVICE, name=DEVICE, is_virtual=False, status="online"))
        db.commit()
        assert _is_demo() is False, "已接入真硬件的设备不能被标成演示"

        current = _row()
        if current is not None:
            current.is_virtual = True
        db.commit()
        assert _is_demo() is True, "没接入过硬件的设备必须按演示源标注"
    finally:
        # 还原测试库原状：原来没这行就删掉，原来有就恢复 is_virtual
        if not had_row:
            db.execute(delete(Device).where(Device.device_id == DEVICE))
        else:
            current = _row()
            if current is not None:
                current.is_virtual = prev_virtual
        db.commit()
        db.close()
    print("is_demo 跟随 devices 表持久标记 -> OK")


def test_sensor_history(client: TestClient) -> None:
    r = client.get(f"/api/sensors/{DEVICE}?days=90")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_id"] == DEVICE
    assert body["count"] == len(body["items"]) >= 40
    assert len(body["predictions"]) >= 1, "预警等级演进为空，大屏的等级时间轴会空白"
    first = body["items"][0]
    # level 是库水位（只有关联水位站才有值），前端据此多画一条水位线
    assert set(first) == {"ts", "R", "P", "T", "H", "RN", "RNM", "S", "D",
                          "level"}, first
    assert first["ts"].endswith("Z")
    assert body["mode"] in ("full", "sentinel_only")
    levels = [p["combined_level"] for p in body["predictions"]]
    assert all(0 <= lv <= 4 for lv in levels), levels
    print(f"/api/sensors/{DEVICE} -> 读数 {body['count']} 条、预测 {len(levels)} 条")

    r = client.get("/api/sensors/not-exist-node")
    assert r.status_code == 404, r.text
    print("未注册设备 -> 404 OK")


def test_alerts_and_ack(client, admin) -> None:
    from database import Alert, SessionLocal
    db = SessionLocal()
    try:
        db.add(Alert(device_id=DEVICE, ts=datetime.now(timezone.utc).replace(tzinfo=None),
                     level=3, stage="高度预警", reason="契约测试", status="open"))
        db.commit()
        alert_id = db.query(Alert).order_by(Alert.id.desc()).first().id
    finally:
        db.close()

    body = client.get("/api/alerts?status=open").json()
    assert body["count"] >= 1
    ids = [a["id"] for a in body["items"]]
    assert alert_id in ids, ids
    target = next(a for a in body["items"] if a["id"] == alert_id)
    for key in ("id", "device_id", "ts", "level", "stage", "reason", "status",
                "acked_by", "acked_at"):
        assert key in target, f"告警缺少字段 {key}"
    assert target["ts"].endswith("Z")

    r = admin.post(f"/api/alerts/{alert_id}/ack")
    assert r.status_code == 200 and r.json()["status"] == "acked", r.text
    after = client.get("/api/alerts?status=acked").json()
    acked = next(a for a in after["items"] if a["id"] == alert_id)
    assert acked["acked_by"] == "admin" and acked["acked_at"], acked
    print(f"告警 {alert_id} 创建 -> 列出 -> 确认 -> OK")
    admin.post(f"/api/alerts/{alert_id}/ack")                        # 幂等，不应报错
    assert admin.post("/api/alerts/999999/ack").status_code == 404


def test_iso_utc() -> None:
    assert iso_utc(None) is None
    naive = datetime(2026, 9, 13, 23, 0, 0)
    assert iso_utc(naive) == "2026-09-13T23:00:00Z", iso_utc(naive)
    aware = datetime(2026, 9, 13, 23, 0, 0, tzinfo=timezone.utc)
    assert iso_utc(aware) == "2026-09-13T23:00:00Z"
    print("时间输出统一带 Z -> OK")


def main() -> None:
    ensure_min_series(DEVICE, days=40)

    from main import app
    with TestClient(app) as raw:
        client = authed_client(raw)                 # 普通用户（只读）
        admin = authed_client(raw, admin=True)      # 管理人员（可确认告警）
        test_iso_utc()
        test_devices(client)
        test_is_demo_follows_db_mark(client)
        test_sensor_history(client)
        test_alerts_and_ack(client, admin)
    print("P5 大屏接口契约测试通过")


if __name__ == "__main__":
    main()
