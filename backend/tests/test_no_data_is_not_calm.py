"""没数据 ≠ 平静：不可用的行必须被标出来，且不能驱动告警。

背景（2026-09-23）：哨兵层原来把算不出的 z 用 `np.nan_to_num(nan=0.0)` 统一填成 0，
于是"近 24 小时没有任何可用位移增量"被判成 **0 级平静**，大屏显示
"正常监测，无需动作"。设备掉线、通道全空、整段停更，都会被读成一切正常 ——
这是预警系统里最危险的一种谎。

现在 `Warning.data_available` 单独标出可用性：等级照旧给 0（维持 0–4 契约），
但调用方据此不下发告警、界面显示"数据不足"。

运行：cd web/backend && python tests/test_no_data_is_not_calm.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)

from services.predictor import predictor  # noqa: E402


def _series(days: int = 120, tail_nan: int = 0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """造一条日尺度序列；tail_nan > 0 时把末尾若干天的位移置空（模拟停更）。"""
    ts = pd.date_range("2026-01-01", periods=days, freq="D")
    disp = 8.0 + np.arange(days) * 0.05
    if tail_nan:
        disp[-tail_nan:] = np.nan
    df = pd.DataFrame({"ts": ts, "disp": disp, "rain": 0.0})
    raw = df[["ts", "disp", "rain"]].copy()
    return df, raw


def test_normal_series_is_available() -> None:
    df, raw = _series()
    last = predictor.predict_series(df, raw_df=raw)[-1]
    assert last["data_available"] is True, last
    assert not any("未更新" in n for n in last["notes"]), last["notes"]
    print("[OK] 正常序列：data_available=True（照常给等级）")


def test_no_data_is_flagged_not_calm() -> None:
    df, raw = _series(tail_nan=3)
    last = predictor.predict_series(df, raw_df=raw)[-1]
    assert last["data_available"] is False, (
        "位移增量算不出来时必须标成不可用 —— 否则会被读成 0 级平静")
    assert any("未更新" in n for n in last["notes"]), last["notes"]
    # 等级本身仍落在 0–4 契约内（前端靠 data_available 区分显示）
    assert 0 <= last["combined_level"] <= 4
    print(f"[OK] 停更序列：data_available=False，等级仍为 {last['combined_level']}"
          f"（由界面显示'数据不足'，不再冒称平静）")


def test_evaluate_skips_alerts_when_no_data() -> None:
    """端到端：数据不可用时 evaluate_device 不下发告警，返回 alert_action=no_data。"""
    from database import Prediction, SensorReading, SessionLocal, init_db
    from services import ingest

    dev = "nodata-probe"
    init_db()
    db = SessionLocal()
    try:
        for model in (SensorReading, Prediction):
            for row in db.query(model).filter(model.device_id == dev).all():
                db.delete(row)
        db.commit()
        ts = pd.date_range(end=pd.Timestamp.now(tz='UTC').tz_localize(None).normalize(), periods=120, freq="D")
        disp = 8.0 + np.arange(120) * 0.05
        disp[-3:] = np.nan                     # 末尾三天没有位移
        for t, d in zip(ts, disp):
            db.add(SensorReading(device_id=dev, ts=t.to_pydatetime(), D=None if pd.isna(d) else float(d),
                                 R=1.0, P=1.0, T=20.0, H=60.0, RN=0.0, S=35.0,
                                 source="simulation"))
        db.commit()
    finally:
        db.close()

    out = ingest.evaluate_device(dev)
    assert out is not None, "应能推理出结果（而不是直接跳过）"
    assert out.get("data_available") is False, out
    assert out.get("alert_action") == "no_data", out
    print("[OK] 数据不足时 evaluate_device 返回 alert_action=no_data，不新建/不解除告警")


def main() -> None:
    test_normal_series_is_available()
    test_no_data_is_flagged_not_calm()
    test_evaluate_skips_alerts_when_no_data()
    print("\nP15 「没数据 ≠ 平静」测试通过")


if __name__ == "__main__":
    main()
