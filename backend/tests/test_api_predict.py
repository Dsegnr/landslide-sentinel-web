"""P3 接口层冒烟测试：POST /api/predict 与 GET /api/predict/{device_id}。

运行：cd web/backend && python tests/test_api_predict.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, ensure_min_series, setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库

from fastapi.testclient import TestClient  # noqa: E402

from database import init_db  # noqa: E402
from main import app  # noqa: E402
from services.ingest import poll_all  # noqa: E402

MODELS = Path(__file__).resolve().parents[1] / "models"


def main() -> None:
    init_db()
    ensure_min_series("slope-node-01", days=40)
    raw = pd.read_parquet(MODELS / "baijiabao_daily_warning.parquet")
    # JSON 不接受 NaN：真实请求由客户端保证；测试里先剔除缺失行
    raw = raw.dropna(subset=["ts", "ZD1", "rain_mm", "level_m"]).tail(200)
    rows = [
        {"ts": str(r.ts)[:19], "disp": float(r.ZD1), "rain": float(r.rain_mm),
         "level": float(r.level_m)}
        for r in raw.tail(200).itertuples()
    ]

    with TestClient(app) as raw:
        c = authed_client(raw)
        r = c.post("/api/predict", json={"device_id": "baijiabao-demo", "rows": rows,
                                         "channel_cols": ["disp"]})
        assert r.status_code == 200, r.text
        body = r.json()
        latest = body["latest"]
        print(f"POST /api/predict -> mode={latest['mode']} 哨兵={latest['sentinel_level']} "
              f"预警={latest['forecast_level']} 融合={latest['combined_level']} "
              f"p30={latest['p30']:.4f} stage={latest['stage']}")
        assert latest["mode"] == "full", latest
        assert latest["p30"] is not None
        assert latest["stage"] in ("平静", "关注", "预警", "高度预警", "警报")

        # 无库水位时应降级为 sentinel_only
        rows_nolevel = [{k: v for k, v in row.items() if k != "level"} for row in rows]
        r2 = c.post("/api/predict", json={"device_id": "no-level", "rows": rows_nolevel})
        assert r2.status_code == 200, r2.text
        b2 = r2.json()["latest"]
        print(f"无库水位 -> mode={b2['mode']} 融合={b2['combined_level']} 说明={b2['notes']}")
        assert b2["mode"] == "sentinel_only" and b2["p30"] is None

        # 从数据库读（先跑一次轮询写入模拟数据）
        asyncio.run(poll_all())
        r3 = c.get("/api/predict/slope-node-01?days=30")
        assert r3.status_code == 200, r3.text
        print("GET 从库读 ->", r3.json()["latest"]["stage"], r3.json()["latest"]["mode"])

    print("P3 接口测试通过")


if __name__ == "__main__":
    main()
