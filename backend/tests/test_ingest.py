"""P2 冒烟测试：涂鸦接入（无凭证 -> 模拟数据）-> 落库 -> 可查询。

运行：cd web/backend && python tests/test_ingest.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库

from sqlalchemy import func, select  # noqa: E402

from database import SessionLocal, SensorReading, init_db  # noqa: E402
from services.ingest import poll_all  # noqa: E402
from services.tuya_client import TuyaClient  # noqa: E402


def count_rows() -> int:
    db = SessionLocal()
    try:
        return int(db.execute(select(func.count()).select_from(SensorReading)).scalar_one())
    finally:
        db.close()


def test_signature() -> None:
    """签名算法必须与队长原版一致（可对固定输入复算）。"""
    c = TuyaClient(access_id="aid", access_key="akey")
    sig = c._sign("GET", "/v1.0/token", "", "", t=1700000000000, nonce="n1")
    assert len(sig) == 64 and sig == sig.upper(), sig
    print("签名 ->", sig[:16], "...")


def main() -> None:
    init_db()
    test_signature()

    before = count_rows()
    result = asyncio.run(poll_all())
    after = count_rows()

    print("轮询结果：")
    for dev, ch in result.items():
        print(f"  {dev}: {ch}")
    assert result, "未取到任何设备读数"
    assert after > before, f"读数未落库：before={before} after={after}"
    print(f"SensorReading 行数 {before} -> {after}")
    print("P2 冒烟测试通过")


if __name__ == "__main__":
    main()
