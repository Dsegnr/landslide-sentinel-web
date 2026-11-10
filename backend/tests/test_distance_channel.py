"""位移模块的口径测试：现场报的是**原始测距**，位移由我们换算。

背景（2026-09-23 与硬件负责人确认 + 原型数据核对）：位移模块是激光/ToF 测距，
报上来的 `DIST` 是"传感器到目标物的距离"（约 890 mm），**不是位移**；
遮挡/没打到目标时会掉到几十毫米甚至个位数（原型遮挡段实测中位 150、最小 36）。

所以要守住：
  1. `D = 基线 − DIST`，基线取**第一次有效测距**（跨重启不变）；
  2. 无效测距**只丢这一路**，同一报文里的温度/湿度等照常入库（不能因为一次遮挡全丢）；
  3. 基线可以手动重标（现场换安装位置之后）。

运行：cd web/backend && python tests/test_distance_channel.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)

from sqlalchemy import delete, select  # noqa: E402

from database import DeviceBaseline, SensorReading, SessionLocal, init_db  # noqa: E402
from services.ingest import (DIST_MAX_VALID, DIST_MIN_VALID, get_baseline,  # noqa: E402
                             save_reading, set_baseline)

DEV = "dist-node-test"
BASE_MM = 890.0


def clear() -> None:
    db = SessionLocal()
    try:
        db.execute(delete(SensorReading).where(SensorReading.device_id == DEV))
        db.execute(delete(DeviceBaseline).where(DeviceBaseline.device_id == DEV))
        db.commit()
    finally:
        db.close()


def rows() -> list[SensorReading]:
    db = SessionLocal()
    try:
        return list(db.execute(
            select(SensorReading).where(SensorReading.device_id == DEV)
            .order_by(SensorReading.ts)).scalars().all())
    finally:
        db.close()


def main() -> None:
    init_db()
    clear()
    t0 = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=3)

    # 1) 第一次有效测距 → 自动记基线，位移从 0 起算
    save_reading(DEV, {"DIST": BASE_MM, "T": 25.0}, ts=t0, source="hardware")
    info = get_baseline(DEV)
    assert info and abs(info["baseline_mm"] - BASE_MM) < 1e-6, info
    assert rows()[0].D == 0.0 and rows()[0].DIST == BASE_MM
    print(f"[OK] 首次有效测距 {BASE_MM:.0f} mm → 自动记基线，D = 0")

    # 2) 目标物向传感器靠近 20 mm → 位移 +20 mm（D = 基线 − 测距）
    save_reading(DEV, {"DIST": BASE_MM - 20, "T": 25.1}, ts=t0 + timedelta(minutes=1),
                 source="hardware")
    assert abs(rows()[1].D - 20.0) < 1e-6, rows()[1].D
    print("[OK] 测距 870 mm → D = +20.0 mm（位移 = 基线 − 测距）")

    # 3) 无效测距（遮挡/没打到目标）：只丢测距，同报文其它通道照常入库
    save_reading(DEV, {"DIST": 36, "T": 25.2, "H": 70}, ts=t0 + timedelta(minutes=2),
                 source="hardware")
    last = rows()[-1]
    assert last.DIST is None, last.DIST            # 无效测距不落库
    assert last.D is None, last.D                  # 因此也不产生假位移
    assert last.T == 25.2 and last.H == 70, (last.T, last.H)
    print("[OK] 无效测距 36 mm → 只丢测距这一路，温度/湿度照常入库、不产生假位移")

    # 4) 超量程同样无效
    save_reading(DEV, {"DIST": DIST_MAX_VALID + 1}, ts=t0 + timedelta(minutes=3),
                 source="hardware")
    assert rows()[-1].DIST is None
    print(f"[OK] 超量程（>{DIST_MAX_VALID:.0f} mm）同样按无效处理")

    # 5) 基线手动重标：换安装位置之后，位移从 0 重新起算
    save_reading(DEV, {"DIST": BASE_MM - 20}, ts=t0 + timedelta(minutes=4), source="hardware")
    set_baseline(DEV, BASE_MM - 20, source="manual", note="测试重标")
    save_reading(DEV, {"DIST": BASE_MM - 20}, ts=t0 + timedelta(minutes=5), source="hardware")
    assert rows()[-1].D == 0.0, rows()[-1].D
    assert get_baseline(DEV)["source"] == "manual"
    print("[OK] 手动重标基线 → 位移重新从 0 起算（基线来源标记为 manual）")

    # 6) 不传值时用最近一条有效测距当基线
    set_baseline(DEV)
    assert abs(get_baseline(DEV)["baseline_mm"] - (BASE_MM - 20)) < 1e-6
    print("[OK] 不显式给值 → 用最近一条有效测距当基线")

    # 7) 常量自检：有效区间要真的能挡住原型里那些无效读数
    assert DIST_MIN_VALID > 36 and DIST_MIN_VALID <= 100
    print(f"[OK] 有效测距区间 [{DIST_MIN_VALID:.0f}, {DIST_MAX_VALID:.0f}] mm"
          f"（挡住原型遮挡段的 36 mm 与个位数）")

    clear()
    print("\n位移通道（原始测距 → 累计位移）测试通过")


if __name__ == "__main__":
    main()
