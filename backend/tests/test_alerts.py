"""P4 验收测试：告警的 创建 / 去重 / 升级 / 解除 / 确认 全流程。

构造三段人造序列（平静 -> 加速 -> 平静），直接驱动告警引擎，
验证状态机符合预期。

运行：cd web/backend && python tests/test_alerts.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库

from sqlalchemy import select  # noqa: E402

from database import Alert, Prediction, SessionLocal, init_db  # noqa: E402
from services.alert_engine import CLEAR_AFTER, MIN_ALERT_LEVEL, engine  # noqa: E402

DEV = "test-alert-device"


def reset() -> None:
    db = SessionLocal()
    try:
        for t in (Alert, Prediction):
            for row in db.execute(select(t).where(t.device_id == DEV)).scalars().all():
                db.delete(row)
        db.commit()
    finally:
        db.close()


def main() -> None:
    init_db()
    reset()
    db = SessionLocal()
    t0 = datetime(2025, 1, 1, tzinfo=timezone.utc)
    try:
        # 1) 平静：不应产生告警
        d = engine.process(db, DEV, 0, "平静", "基线", t0)
        assert d.action == "none", d
        print("平静 ->", d.action)

        # 2) 升到 2 级：创建
        d = engine.process(db, DEV, 2, "预警", "位移加速", t0 + timedelta(hours=1))
        assert d.action == "created" and d.alert_id, d
        first_id = d.alert_id
        print("2 级 ->", d.action, "alert_id=", first_id)

        # 3) 再报 2 级：去重（不新建）
        d = engine.process(db, DEV, 2, "预警", "位移加速", t0 + timedelta(hours=2))
        assert d.action == "deduped" and d.alert_id == first_id, d
        print("重复 2 级 ->", d.action)

        # 4) 升到 4 级：在同一记录上升级
        d = engine.process(db, DEV, 4, "警报", "持续加速", t0 + timedelta(hours=3))
        assert d.action == "escalated" and d.alert_id == first_id, d
        a = db.get(Alert, first_id)
        assert a.level == 4 and "升级" in a.reason, a.reason
        print("升到 4 级 ->", d.action, "| level =", a.level)

        # 5) 回落但未达解除条件：不动
        d = engine.process(db, DEV, 1, "关注", "回落", t0 + timedelta(hours=4))
        assert d.action == "none", d
        print("回落到 1 级 ->", d.action)

        # 6) 连续 CLEAR_AFTER 次低级别预测：解除
        for i in range(CLEAR_AFTER):
            db.add(Prediction(device_id=DEV, ts=t0 + timedelta(hours=5 + i),
                              sentinel_level=0, forecast_level=0, combined_level=0, stage="平静"))
        db.commit()
        d = engine.process(db, DEV, 0, "平静", "稳定", t0 + timedelta(hours=9))
        assert d.action == "cleared", d
        print(f"连续 {CLEAR_AFTER} 次低级别 ->", d.action)

        # 7) 新事件再起：应新建（因为上一条已 cleared）
        d = engine.process(db, DEV, 3, "高度预警", "再次加速", t0 + timedelta(hours=10))
        assert d.action == "created" and d.alert_id != first_id, d
        second_id = d.alert_id
        print("新事件 ->", d.action, "alert_id=", second_id)

        # 8) 确认
        assert engine.ack(db, second_id, "admin@test") is True
        assert db.get(Alert, second_id).status == "acked"
        print("确认 -> acked")

        assert MIN_ALERT_LEVEL == 2
    finally:
        db.close()
    print("P4 验收测试通过")


if __name__ == "__main__":
    main()
