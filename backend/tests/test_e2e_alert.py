"""P4 端到端测试：注入一段"加速"数据 -> 系统应自动产生分级告警。

模拟一次真实事件：设备先平稳运行 120 天，随后位移加速，
看系统能否在**无需人工干预**的情况下自动推理、落库并开出告警。

运行：cd web/backend && python tests/test_e2e_alert.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from database import Alert, Prediction, SessionLocal, SensorReading, init_db  # noqa: E402
from main import app  # noqa: E402
from services.ingest import evaluate_device  # noqa: E402

DEV = "e2e-slope-node"


def reset() -> None:
    db = SessionLocal()
    try:
        for t in (Alert, Prediction, SensorReading):
            for row in db.execute(select(t).where(t.device_id == DEV)).scalars().all():
                db.delete(row)
        db.commit()
    finally:
        db.close()


def inject(n_quiet: int = 120, n_rise: int = 10) -> None:
    """平稳 120 天 + 加速 10 天（位移累计，日增由小变大）。"""
    rng = np.random.default_rng(7)
    db = SessionLocal()
    try:
        # 必须落在服务的时间窗内（`evaluate_device` 只看最近 200 天），
        # 否则会被当成"过期历史"而不参与推理 —— 这里按"到昨天为止"构造。
        t0 = (datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
              - timedelta(days=n_quiet + n_rise))
        disp = 8.0
        for i in range(n_quiet + n_rise):
            step = rng.normal(0, 0.05) if i < n_quiet else 0.8 + rng.normal(0, 0.1)
            disp += step
            db.add(SensorReading(
                device_id=DEV, ts=t0 + timedelta(days=i),
                R=1.0 + rng.normal(0, 0.2), P=1.0 + rng.normal(0, 0.2),
                T=20.0 + rng.normal(0, 1), H=60.0 + rng.normal(0, 5),
                RN=max(0.0, rng.normal(2, 3)), S=40.0 + rng.normal(0, 3),
                D=disp,
            ))
        db.commit()
    finally:
        db.close()


def main() -> None:
    init_db()
    reset()
    inject()

    result = evaluate_device(DEV)
    assert result is not None, "推理未返回结果"
    print(f"推理 -> 哨兵={result['sentinel_level']} 融合={result['combined_level']} "
          f"stage={result['stage']} alert={result['alert_action']}")
    assert result["combined_level"] >= 2, f"加速段未触发告警：{result}"
    assert result["alert_action"] in ("created", "deduped", "escalated"), result

    with TestClient(app) as raw:
        c = authed_client(raw)
        admin = authed_client(raw, admin=True)
        r = c.get("/api/alerts?status=open")
        assert r.status_code == 200, r.text
        body = r.json()
        print("开放告警：", body["count"])
        for it in body["items"][:3]:
            print("  ", it["ts"], it["stage"], it["level"], it["reason"][:40])
        assert body["count"] >= 1, body

        aid = body["items"][0]["id"]
        r = admin.post(f"/api/alerts/{aid}/ack")
        assert r.status_code == 200 and r.json()["status"] == "acked", r.text
        print("确认告警 ->", r.json())
    print("P4 端到端测试通过")


if __name__ == "__main__":
    main()
