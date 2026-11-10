"""P5 前置测试：采样率与模拟数据源的**口径正确性**。

覆盖两个线上最容易翻车的点：
  1. 硬件是分钟/秒级，模型是日尺度——`to_daily` 必须把亚日采样正确聚合为日尺度，
     且对已经是日尺度的输入**逐值不变**（否则与算法侧对不上）；
  2. 无涂鸦凭证时的虚拟设备必须与库里最近读数**连续**，不能每次各自随机。

运行：cd web/backend && python tests/test_sampling.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)          # 必须在 import database / services 之前

from services.predictor import WarningPredictor  # noqa: E402
from services.virtual_device import advance  # noqa: E402


def test_daily_input_untouched() -> None:
    """日尺度输入必须原样通过（与算法侧逐日比对的前提）。"""
    ts = pd.date_range("2026-01-01", periods=10, freq="1D")
    df = pd.DataFrame({"ts": ts, "disp": range(10), "rain": [1.0] * 10})
    out = WarningPredictor.to_daily(df)
    assert len(out) == 10, len(out)
    assert list(out["disp"]) == list(df["disp"])
    assert list(out["rain"]) == list(df["rain"])
    print("日尺度输入保持不变 -> OK")


def test_minute_to_daily() -> None:
    """分钟级输入：位移取当日最后一条、雨量取当日累加、通道取当日最后一条。"""
    rows = []
    t0 = datetime(2026, 1, 1, 0, 0)
    for day in range(3):
        for k in range(6):                       # 每天 6 条（每 4 小时一条）
            ts = t0 + timedelta(days=day, hours=4 * k)
            rows.append({"ts": ts, "disp": day * 10 + k, "rain": 2.0, "level": 100 + day})
    out = WarningPredictor.to_daily(pd.DataFrame(rows))
    assert len(out) == 3, f"应按日聚合为 3 行，实际 {len(out)}"
    assert list(out["disp"]) == [5, 15, 25], list(out["disp"])   # 当日最后一条
    assert list(out["rain"]) == [12.0, 12.0, 12.0], list(out["rain"])  # 当日累加
    assert list(out["level"]) == [100, 101, 102]
    assert out["ts"].dt.day.tolist() == [1, 2, 3], out["ts"].tolist()   # ts 落在当日
    print("分钟级 -> 日尺度聚合 -> OK")


def test_gap_not_filled() -> None:
    """缺测日**不补齐**：插入空行会改变 7/14/30 日窗口的行移位语义。"""
    ts = [datetime(2026, 1, 1), datetime(2026, 1, 2), datetime(2026, 1, 10)]
    df = pd.DataFrame({"ts": ts, "disp": [1.0, 2.0, 3.0], "rain": [0.0, 0.0, 0.0]})
    out = WarningPredictor.to_daily(df)
    assert len(out) == 3, f"不应补行，实际 {len(out)}"
    print("缺测日不补齐 -> OK")


def test_virtual_device_continuity() -> None:
    """虚拟设备必须与库里最近读数连续，且速率估计可解释。"""
    probe = "sampling-probe-node"
    base = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=30)
    rows = []
    disp = 10.0
    for i in range(30):
        disp += 0.5
        rows.append({"ts": base + timedelta(days=i), "disp": disp, "rain": 0.0})
    from database import SessionLocal, SensorReading, init_db
    init_db()
    db = SessionLocal()
    try:
        db.query(SensorReading).filter(SensorReading.device_id == probe).delete()
        for r in rows:
            db.add(SensorReading(device_id=probe, ts=r["ts"], D=r["disp"], RN=r["rain"]))
        db.commit()
        last = rows[-1]["disp"]
    finally:
        db.close()

    out = advance(probe)
    jump = out["D"] - last
    assert out["D"] >= last, f"位移不应倒退：{last} -> {out['D']}"
    assert jump < 1.0, f"单次推进过大（数据被打断的信号）：{jump:.3f} mm"
    assert 0.3 < out["D"] - last < 0.9, f"应按最近速率(0.5 mm/d)推进，实际 {jump:.3f}"
    assert 0 <= out["H"] <= 99 and 0 <= out["S"] <= 100, out
    print(f"虚拟设备连续性 -> OK（最近速率 0.5 mm/d，本次推进 {jump:.3f} mm）")


def test_drift_estimate_uses_time_span() -> None:
    """速率估计必须按"时间跨度"算，不能按"最近 N 条读数"。

    线上踩过的坑：分钟级采样下最近 30 条只覆盖几十分钟，噪声被当成趋势、
    再撞上 30 mm/d 上限 → 位移一天涨 2 mm、倾角顶到 45°（画面明显不合理）。
    """
    from datetime import datetime, timedelta
    from types import SimpleNamespace

    from services.virtual_device import estimate_drift

    base = datetime(2026, 1, 1)

    def mk(ts, d):
        return SimpleNamespace(ts=ts, D=d)

    daily = [mk(base + timedelta(days=i), 10 + 0.5 * i) for i in range(30)]
    assert abs(estimate_drift(daily) - 0.5) < 0.05, estimate_drift(daily)

    # 日尺度历史 + 最后 60 条分钟级读数（正是线上情形）
    noisy = daily + [mk(base + timedelta(days=29, minutes=m), 24.5 + 0.0004 * m)
                     for m in range(60)]
    rate = estimate_drift(noisy)
    assert 0.4 < rate < 0.6, f"分钟级噪声不该被当成趋势，实际 {rate:.2f} mm/d"
    print(f"速率估计 -> OK（日尺度 0.5，混入分钟级噪声后仍为 {rate:.3f} mm/d）")


def test_daily_aggregate_in_sql_not_truncated() -> None:
    """高采样率设备的历史不能被**静默截断**（2026-09-16 修正）。

    旧实现是"先取最多 max_rows 行、再在 pandas 里按日聚合"：1 分钟采样时
    20000 行只够约 14 天，`days=400` 的请求会悄悄缩成 14 天，且**不报任何错**。
    """
    from sqlalchemy import delete

    from database import SensorReading, SessionLocal, init_db
    from services.ingest import load_series

    dev = "slope-hf-test"
    init_db()
    db = SessionLocal()
    try:
        db.execute(delete(SensorReading).where(SensorReading.device_id == dev))
        t0 = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=30)
        for i in range(30 * 1440):                    # 30 天 × 每分钟一条 = 43200 行
            db.add(SensorReading(device_id=dev, ts=t0 + timedelta(minutes=i),
                                 R=1.0, P=1.0, T=20.0, H=60.0, RN=1.0, S=40.0,
                                 D=10.0 + i * 0.001))
        db.commit()
    finally:
        db.close()

    df = load_series(dev, days=60)
    assert df is not None, "高采样率设备也必须能取到日尺度历史"
    # 起点是"now−30 天"，会跨 31 个自然日；关键是不能被截断成 ~14 天
    assert len(df) >= 29, f"30 天分钟级读数应聚合出约 30 天，实际 {len(df)}（旧实现会是 14）"

    db = SessionLocal()
    try:
        db.execute(delete(SensorReading).where(SensorReading.device_id == dev))
        db.commit()
    finally:
        db.close()
    print(f"[OK] 高采样率不被截断：43200 条分钟级读数 → {len(df)} 天日尺度")


def test_daily_aggregate_matches_pandas() -> None:
    """SQL 侧日聚合必须与 pandas 口径**逐值一致**：位移取当日最后、雨量当日累加。"""
    from sqlalchemy import delete

    from database import SensorReading, SessionLocal, init_db
    from services.ingest import load_raw_series, load_series
    from services.predictor import predictor

    dev = "slope-agg-test"
    init_db()
    db = SessionLocal()
    try:
        db.execute(delete(SensorReading).where(SensorReading.device_id == dev))
        t0 = datetime(2026, 1, 1, 3, 0, 0)
        for d in range(5):
            for k in range(60):                       # 每天 60 条
                db.add(SensorReading(device_id=dev, ts=t0 + timedelta(days=d, minutes=k),
                                     R=1.0, P=1.0, T=20.0, H=60.0, RN=0.5, S=40.0,
                                     D=10.0 + d * 1.0 + k * 0.01))
        db.commit()
    finally:
        db.close()

    raw = load_raw_series(dev, days=400)
    old = predictor.to_daily(raw)
    new = load_series(dev, days=400)
    assert old is not None and new is not None
    assert len(old) == len(new) == 5, f"{len(old)} vs {len(new)}"
    for col in ("disp", "rain"):
        a = old[col].astype(float).round(6).tolist()
        b = new[col].astype(float).round(6).tolist()
        assert a == b, f"{col} 不一致：{a[:3]} vs {b[:3]}"

    db = SessionLocal()
    try:
        db.execute(delete(SensorReading).where(SensorReading.device_id == dev))
        db.commit()
    finally:
        db.close()
    print("[OK] SQL 侧日聚合与 pandas 口径逐值一致")


def test_fixed_drift_moves_at_minute_sampling() -> None:
    """固定速率的演示点，在**分钟级追加**下也必须真的在动。

    踩过的坑（2026-09-23 实测）：位移写库时 `round(..., 3)`，而演示点标定速率
    0.15 mm/d 折到每分钟只有 0.000104 mm —— 取整后增量被整个抹掉，
    位移从此长期不动（库里整天跨度 0.0000），哨兵层的滚动增量趋零、等级掉级。
    所以位移必须按更高精度落库（现为 5 位小数）。
    """
    from database import SensorReading, SessionLocal, init_db
    from services.device_manager import manager

    dev = "demo-node-01"
    info = manager.get(dev)
    assert info is not None and info.drift_mm_per_day, "演示点应配置固定速率"
    drift = float(info.drift_mm_per_day)

    init_db()
    db = SessionLocal()
    try:
        db.query(SensorReading).filter(SensorReading.device_id == dev).delete()
        base = 8.0
        db.add(SensorReading(
            device_id=dev, source="simulation", D=base,
            ts=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)))
        db.commit()
    finally:
        db.close()

    out = advance(dev)
    step = float(out["D"]) - base
    per_minute = drift / 1440.0
    assert step > 0, (f"分钟级追加把位移增量抹掉了（{base} -> {out['D']}）："
                      f"落库精度不足以表达每分钟 {per_minute:.6f} mm")
    assert step <= per_minute * 2, f"单步推进异常偏大：{step:.6f} vs 期望 {per_minute:.6f}"
    print(f"固定速率演示点分钟级仍在推进 -> OK（每分钟 {step:.6f} mm）")


def main() -> None:
    test_daily_input_untouched()
    test_minute_to_daily()
    test_gap_not_filled()
    test_daily_aggregate_in_sql_not_truncated()
    test_daily_aggregate_matches_pandas()
    test_virtual_device_continuity()
    test_fixed_drift_moves_at_minute_sampling()
    test_drift_estimate_uses_time_span()
    print("P5 采样率与模拟数据源测试通过")


if __name__ == "__main__":
    main()
