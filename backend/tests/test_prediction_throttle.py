"""P5 测试：推理落库节流。

模型是日尺度的，但硬件每分钟上报一次；如果每次轮询都写一条预测，
一天就是 1440 行/设备（MySQL 里纯属垃圾数据），大屏的等级演进图也会被刷屏。

规则（见 services/ingest.py）：
  * 等级**没变**且距上一条记录不足 5 分钟 -> 不落库（throttled）；
  * 等级**变化**时立即记录，保证告警可追溯；
  * 每次都返回最新推理结果（大屏展示不受影响）。

运行：cd web/backend && python tests/test_prediction_throttle.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import ensure_min_series, setup  # noqa: E402

setup(__file__)

from sqlalchemy import func, select  # noqa: E402

from database import Prediction, SessionLocal  # noqa: E402
from services.ingest import PREDICTION_MIN_INTERVAL_SECONDS, evaluate_device  # noqa: E402

DEV = "throttle-probe-node"


def count_predictions() -> int:
    db = SessionLocal()
    try:
        return int(db.execute(
            select(func.count()).select_from(Prediction)
            .where(Prediction.device_id == DEV)
        ).scalar_one())
    finally:
        db.close()


def main() -> None:
    ensure_min_series(DEV, days=40)

    first = evaluate_device(DEV)
    assert first is not None, "推理未返回结果"
    first_ts = first.get("alert_action")
    n1 = count_predictions()
    print(f"第一次推理 -> 等级 {first['combined_level']} 动作 {first_ts} 记录数 {n1}")

    second = evaluate_device(DEV)
    assert second is not None
    n2 = count_predictions()
    assert second["alert_action"] == "throttled", f"5 分钟内重复推理不该再落库：{second}"
    assert n2 == n1, f"记录数不应增加：{n1} -> {n2}"
    assert second["combined_level"] == first["combined_level"], "节流不应改变推理结果"
    print(f"第二次推理 -> 动作 {second['alert_action']}，记录数保持 {n2}，"
          f"节流窗口 {PREDICTION_MIN_INTERVAL_SECONDS}s")
    print("P5 推理节流测试通过")


if __name__ == "__main__":
    main()
