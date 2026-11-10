"""生成演示数据：180 天、两台设备的模拟监测序列，并回放推理与告警。

用途：在涂鸦凭证到手前，让大屏、推理接口与告警链路都有真实长度的数据可跑。
**这是模拟数据**——所有生成的读数在库里都标记 device_id 前缀 `demo-`，
接口返回时也会带 `is_demo`，答辩口径上必须如实说明。

运行：cd web/backend && python scripts/seed_demo_data.py
"""
from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database import Alert, Prediction, SensorReading, SessionLocal, init_db  # noqa: E402
from services.device_manager import DeviceInfo, manager  # noqa: E402
from services.reservoir import upsert_levels  # noqa: E402

DAYS = 180
RAMP_DAYS = 30          # 加速段用 30 天缓慢发展，才能看到"关注→预警→高度预警→警报"的升级过程
STATION_ID = "sanxia-demo"   # 演示用库水位站（模拟数据，source=demo）


def gen_levels(station_id: str, seed: int = 5) -> None:
    """生成 180 天模拟库水位。

    量纲照真实库区来（白家包/三峡：汛限水位 145 m、正常蓄水位 175 m，
    汛期 6—7 月最低、蓄水期 10—11 月最高，日变幅多在 ±2 m 内），
    否则模型里的 `draw_7/30/90`（库水位下降速率）特征就没有物理意义。
    **这是模拟数据**，source 标记为 demo。
    """
    rng = np.random.default_rng(seed)
    t0 = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) \
        - timedelta(days=DAYS)
    rows = []
    level = 159.0
    for i in range(DAYS):
        ts = t0 + timedelta(days=i)
        doy = ts.timetuple().tm_yday
        target = 159.0 + 12.5 * math.cos(2 * math.pi * (doy - 320) / 365)
        level += 0.25 * (target - level) + rng.normal(0, 0.18)   # 向季节目标缓慢回归
        level = float(min(175.0, max(145.0, level)))
        rows.append((ts, round(level, 2)))
    result = upsert_levels(station_id, rows, source="demo")
    print(f"  {station_id}: 库水位 {DAYS} 天（{rows[0][1]} → {rows[-1][1]} m）"
          f"新增 {result['inserted']} 更新 {result['updated']}")


def gen(device_key: str, seed: int, step_day: int | None) -> None:
    """step_day 不为空时，在第 step_day 天制造一次位移加速（模拟滑坡前兆）。"""
    rng = np.random.default_rng(seed)
    db = SessionLocal()
    try:
        db.query(SensorReading).filter(SensorReading.device_id == device_key).delete()
        db.query(Prediction).filter(Prediction.device_id == device_key).delete()
        db.query(Alert).filter(Alert.device_id == device_key).delete()
        db.commit()

        # 序列到"昨天"为止（UTC 日界）：今天的数据由虚拟设备实时推进，
        # 避免同一天既有种子数据又有实时读数、把当日增量重复计入哨兵层。
        t0 = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) \
            - timedelta(days=DAYS)
        disp = 6.0
        for i in range(DAYS):
            ts = t0 + timedelta(days=i)
            doy = ts.timetuple().tm_yday
            season = 1.0 + 0.6 * np.sin(2 * np.pi * (doy - 120) / 365)      # 雨季偏大
            if step_day is not None and i >= step_day:
                frac = min(1.0, (i - step_day) / RAMP_DAYS)                 # 加速段：逐步发展
                daily = 0.03 + 0.60 * frac + rng.normal(0, 0.02)
            else:
                daily = 0.02 + rng.normal(0, 0.03)                          # 平稳段
            disp += max(daily, 0.0)
            rain = max(0.0, rng.gamma(1.4, 4.0) * season - 2.0)
            db.add(SensorReading(
                device_id=device_key, ts=ts,
                R=1.2 + rng.normal(0, 0.25) + (0.4 if step_day and i >= step_day else 0),
                P=0.9 + rng.normal(0, 0.2),
                T=18 + 7 * np.sin(2 * np.pi * (doy - 100) / 365) + rng.normal(0, 0.6),
                H=55 + 18 * season * 0.3 + rng.normal(0, 3),
                RN=rain,
                S=35 + 12 * season * 0.4 + rng.normal(0, 2),
                D=disp,
            ))
        db.commit()
    finally:
        db.close()
    print(f"  {device_key}: {DAYS} 天" + ("（含加速段）" if step_day else "（平稳）"))


def main() -> None:
    from scripts.backfill_predictions import backfill

    init_db()
    print("生成演示数据…")
    gen_levels(STATION_ID)
    gen("slope-node-01", seed=11, step_day=150)     # 加速事件：第 150 天起、30 天缓升
    gen("slope-node-02", seed=22, step_day=None)    # 平稳对照
    for key, name, lon, lat, station in (
        ("slope-node-01", "边坡复合监测节点 01", 110.759, 30.983, STATION_ID),
        ("slope-node-02", "边坡复合监测节点 02", 110.760, 30.982, None),
    ):
        manager.register(DeviceInfo(device_id=key, name=name,
                                    channels=["R", "P", "T", "H", "RN", "S", "D"],
                                    station_id=station, lon=lon, lat=lat, is_virtual=True))
    print("完成。设备列表：", [f"{d.device_id}({d.mode})" for d in manager.all()])

    print("回放推理与告警…")
    for key in ("slope-node-01", "slope-node-02"):
        info = backfill(key)
        print(f"  {key}: {info['n_days']} 天 -> 末级 {info['last_level']}"
              f"（{info['last_stage']}）告警动作 {info['actions']}")
    print(f"提示：后端 .env 里配置 RESERVOIR_BINDINGS=slope-node-01:{STATION_ID} "
          f"后，1 号点位会按 full（双时间尺度）模式推理")


if __name__ == "__main__":
    main()
