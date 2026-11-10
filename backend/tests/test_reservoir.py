"""库水位数据源测试：导入幂等、按日对齐、full/sentinel 模式切换与接口契约。

为什么单独测这层：库水位是**硬件拿不到的外部数据**，一旦它出问题（缺口被乱补、
水位站接错、模式没切换），模型会算出"看起来很正常"但其实没有依据的概率值。

运行：cd web/backend && python tests/test_reservoir.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from database import (Alert, Prediction, ReservoirLevel, SensorReading,  # noqa: E402
                      SessionLocal, init_db)
from services.device_manager import DeviceInfo, manager  # noqa: E402
from services.ingest import evaluate_device  # noqa: E402
from services.reservoir import attach_level, load_levels, upsert_levels  # noqa: E402

DEV = "reservoir-probe-node"
STATION = "probe-station"
DAYS = 120
T0 = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) \
    - timedelta(days=DAYS)


def reset() -> None:
    db = SessionLocal()
    try:
        for model in (Prediction, SensorReading, Alert):
            for row in db.query(model).filter(model.device_id == DEV).all():
                db.delete(row)
        for row in db.query(ReservoirLevel).filter(ReservoirLevel.station_id == STATION).all():
            db.delete(row)
        db.commit()
    finally:
        db.close()


def test_upsert_idempotent() -> None:
    """同一站同一天重复导入应更新而不是重复插入。"""
    upsert_levels(STATION, [(T0, 165.0), (T0 + timedelta(days=1), 164.5)], source="test")
    first = load_levels(STATION)
    assert len(first) == 2, first
    upsert_levels(STATION, [(T0 + timedelta(days=1), 164.0)], source="test")
    again = load_levels(STATION)
    assert len(again) == 2, f"重复导入不应新增行：{len(again)}"
    assert abs(float(again.iloc[-1]) - 164.0) < 1e-9, again.tolist()
    print("水位导入幂等 -> OK（重复导入只更新数值）")


def test_attach_alignment() -> None:
    """短缺口（≤3 天）按算法侧规则补齐，长缺口保持缺失——不编数据。"""
    db = SessionLocal()
    try:
        for row in db.query(ReservoirLevel).filter(ReservoirLevel.station_id == STATION).all():
            db.delete(row)
        db.commit()
    finally:
        db.close()

    # 水位：第 0 天 + 第 15~20 天；读数：第 0~20 天（中间 14 天没有水位）
    upsert_levels(STATION, [(T0, 166.0)] + [(T0 + timedelta(days=15 + i), 160.0 - i)
                                            for i in range(6)], source="test")
    rows = [{"ts": T0 + timedelta(days=i), "disp": 8.0 + 0.01 * i, "rain": 0.0}
            for i in range(21)]
    out = attach_level(pd.DataFrame(rows), STATION)

    assert abs(float(out["level"].iloc[0]) - 166.0) < 1e-9, out["level"].tolist()
    assert not pd.isna(out["level"].iloc[3]), "3 天内的缺口应被补齐"
    assert pd.isna(out["level"].iloc[4]), "超过 3 天的缺口必须保持缺失"
    assert pd.isna(out["level"].iloc[14]), out["level"].tolist()
    assert pd.isna(out["level"].iloc[14]), out["level"].tolist()
    assert abs(float(out["level"].iloc[15]) - 160.0) < 1e-9, "有水位数据的日子必须精确对齐"
    print("水位对齐 -> OK（≤3 天补齐，长缺口保持缺失）")


def test_trailing_hold() -> None:
    """读数比水位新（水文数据滞后一天到）时的处理：最近观测值保持 ≤3 天，之后缺失。"""
    db = SessionLocal()
    try:
        for row in db.query(ReservoirLevel).filter(ReservoirLevel.station_id == STATION).all():
            db.delete(row)
        db.commit()
    finally:
        db.close()

    # 水位覆盖第 0~19 天，读数到第 25 天
    upsert_levels(STATION, [(T0 + timedelta(days=i), 165.0 - i) for i in range(20)], source="test")
    rows = [{"ts": T0 + timedelta(days=i), "disp": 8.0, "rain": 0.0} for i in range(26)]
    out = attach_level(pd.DataFrame(rows), STATION)

    assert abs(float(out["level"].iloc[19]) - 146.0) < 1e-9, out["level"].tolist()
    assert abs(float(out["level"].iloc[20]) - 146.0) < 1e-9, "滞后 1 天应保持最近观测值"
    assert abs(float(out["level"].iloc[22]) - 146.0) < 1e-9, "滞后 3 天仍可保持"
    assert pd.isna(out["level"].iloc[23]), "滞后超过 3 天必须保持缺失（不能用过期水位驱动模型）"
    assert pd.isna(out["level"].iloc[25]), out["level"].tolist()
    print("末端滞后 -> OK（≤3 天保持最近观测值，超过则缺失）")


def seed_device() -> None:
    db = SessionLocal()
    try:
        level = 166.0
        disp = 10.0
        for i in range(DAYS):
            ts = T0 + timedelta(days=i)
            level -= 0.05 + (0.02 if i % 7 == 0 else 0.0)      # 缓慢消落
            disp += 0.02 + (0.5 if i >= DAYS - 10 else 0.0)    # 末段加速
            db.add(SensorReading(device_id=DEV, ts=ts, R=1.2, P=1.1, T=20.0, H=60.0,
                                 RN=1.0, S=40.0, D=disp))
        db.commit()
    finally:
        db.close()
    upsert_levels(STATION, [(T0 + timedelta(days=i), 166.0 - 0.05 * i) for i in range(DAYS)],
                  source="test")


def test_mode_switch() -> None:
    """绑定水位站 -> full（有 p7/p30）；解绑 -> sentinel_only（无外推）。"""
    manager.register(DeviceInfo(device_id=DEV, name="水位联调点位",
                                channels=["R", "P", "T", "H", "RN", "S", "D"],
                                station_id=STATION))
    full = evaluate_device(DEV)
    assert full is not None, "推理未返回结果"
    assert full["mode"] == "full", full
    assert full["p30"] is not None and full["p7"] is not None, full
    print(f"绑定水位站 -> mode={full['mode']} p7={full['p7']:.4f} p30={full['p30']:.4f} "
          f"融合={full['combined_level']}")

    manager.set_level_source(DEV, None)
    sentinel = evaluate_device(DEV)
    assert sentinel is not None and sentinel["mode"] == "sentinel_only", sentinel
    assert sentinel["p30"] is None, "没有库水位时不得输出未来概率"
    assert any("未接入库水位" in n for n in sentinel["notes"]), sentinel["notes"]
    print(f"解绑水位站 -> mode={sentinel['mode']} p30={sentinel['p30']} 说明={sentinel['notes']}")

    manager.set_level_source(DEV, STATION)     # 复位，供接口断言使用


def test_api_contract(client: TestClient) -> None:
    body = client.get("/api/devices").json()
    item = next((d for d in body["items"] if d["device_id"] == DEV), None)
    assert item is not None, "设备未出现在 /api/devices"
    assert item["mode"] == "full", item
    assert item["has_level"] is True and item["station_id"] == STATION
    assert item["level_m"] is not None and item["level_days"] > 0, item
    print(f"/api/devices -> mode={item['mode']} 水位={item['level_m']} m "
          f"（{item['level_days']} 天）")

    series = client.get(f"/api/sensors/{DEV}?days=30").json()
    assert series["mode"] == "full" and series["station_id"] == STATION, series
    levels = [p.get("level") for p in series["items"]]
    assert any(v is not None for v in levels), "序列里没有库水位，前端画不出水位线"
    print(f"/api/sensors/{DEV} -> 读数 {series['count']} 条，"
          f"水位非空 {sum(1 for v in levels if v is not None)} 条")


def main() -> None:
    init_db()
    reset()
    test_upsert_idempotent()
    test_attach_alignment()
    test_trailing_hold()
    seed_device()
    test_mode_switch()

    from main import app
    with TestClient(app) as raw:
        test_api_contract(authed_client(raw))
    print("库水位数据源测试通过")


if __name__ == "__main__":
    main()
