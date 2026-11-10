"""P13 验收测试：硬件直连接入（POST /api/ingest/readings）。

覆盖：令牌鉴权 / 未知设备 / 单条 / 批量 / 幂等去重 / 缺通道存空 /
非法通道与非法数值 / 北京时间解析 / 批量上限 / 连通性自检。

运行：cd web/backend && python tests/test_ingest_api.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库
os.environ["INGEST_TOKENS"] = ("slope-node-01:tok-01,slope-node-02:tok-02,"
                               "ghost-device:tok-x")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from database import Device, SensorReading, SessionLocal, init_db  # noqa: E402
from main import app  # noqa: E402

DEV = "slope-node-01"
TOKEN = "tok-01"
URL = "/api/ingest/readings"
HDR = {"X-Device-Token": TOKEN}


def rows() -> list[SensorReading]:
    db = SessionLocal()
    try:
        return list(db.execute(
            select(SensorReading).where(SensorReading.device_id == DEV)
            .order_by(SensorReading.ts)
        ).scalars().all())
    finally:
        db.close()


def clear() -> None:
    db = SessionLocal()
    try:
        for row in db.execute(
                select(SensorReading).where(SensorReading.device_id == DEV)).scalars().all():
            db.delete(row)
        # "已接入真实硬件"的标记也要清掉，否则本用例会带着上轮的通道分工跑
        for row in db.execute(
                select(Device).where(Device.device_id == DEV)).scalars().all():
            db.delete(row)
        db.commit()
    finally:
        db.close()


def main() -> None:
    init_db()
    clear()
    client = TestClient(app)
    body = {"device_id": DEV, "ts": "2026-09-20 14:03:05",
            "channels": {"R": 2.13, "D": 20.2}}

    # 1) 令牌：缺失 / 错误 → 401
    assert client.post(URL, json=body).status_code == 401
    assert client.post(URL, json=body,
                       headers={"X-Device-Token": "wrong"}).status_code == 401
    print("[OK] 无令牌 / 错令牌 → 401")

    # 2) 令牌合法但设备没注册 → **401**（与令牌错误同码同文案：手持一个有效令牌
    #    不能靠 404/401 的差异枚举"哪些 device_id 已登记"；真实原因只进服务端日志）
    res = client.post(URL, json={**body, "device_id": "ghost-device"},
                      headers={"X-Device-Token": "tok-x"})
    assert res.status_code == 401, res.text
    print("[OK] 未注册设备 → 401（防设备号枚举）")

    # 3) 单条写入：200，且落库、时间戳按北京时间解析（14:03:05+08 → 06:03:05Z）
    res = client.post(URL, json=body, headers=HDR)
    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 1 and res.json()["duplicated"] == 0, res.json()
    got = rows()
    assert len(got) == 1, got
    assert got[0].ts == datetime(2026, 9, 20, 6, 3, 5), got[0].ts
    assert got[0].R == 2.13 and got[0].D == 20.2
    assert got[0].T is None, "没给的通道必须存空，不能拿 0 冒充"
    print("[OK] 单条写入 + 北京时间解析 + 缺通道存空")

    # 4) 重复提交同一条 → 幂等，行数不涨
    res = client.post(URL, json=body, headers=HDR)
    assert res.json() == {"accepted": 0, "duplicated": 1,
                          "latest_ts": res.json()["latest_ts"],
                          "prediction_level": res.json()["prediction_level"]}
    assert len(rows()) == 1, "重复提交不能写重"
    print("[OK] 幂等去重（重复提交不写重）")

    # 5) 批量：3 条一次推上来（时间乱序也要按时间落库）
    res = client.post(URL, headers=HDR, json={"device_id": DEV, "items": [
        {"ts": "2026-09-20 14:03:07", "channels": {"R": 2.16, "RN": 0.4}},
        {"ts": "2026-09-20 14:03:06", "channels": {"R": 2.15, "RN": 0.2}},
        {"ts": "2026-09-20 14:03:08", "channels": {"R": 2.17, "RN": 0.9}},
    ]})
    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 3, res.json()
    got = rows()
    assert len(got) == 4
    assert [r.ts for r in got] == sorted(r.ts for r in got), "落库顺序必须是时间序"
    print("[OK] 批量写入（乱序输入按时间落库）")

    # 6) 参数校验：未知通道 / 非数字 / 既没有 ts 也没有 items / 超批量上限
    bad = client.post(URL, headers=HDR, json={
        "device_id": DEV, "ts": "2026-09-20 15:00:00", "channels": {"X": 1.0}})
    assert bad.status_code == 422 and "未知通道" in bad.text, bad.text
    bad = client.post(URL, headers=HDR, json={
        "device_id": DEV, "ts": "2026-09-20 15:00:00", "channels": {"R": "abc"}})
    # 非数字被 pydantic 拦下（返回 FastAPI 的标准 422 结构），只要不写进库即可
    assert bad.status_code == 422, bad.text
    bad = client.post(URL, headers=HDR, json={"device_id": DEV})
    assert bad.status_code == 422, bad.text
    base = datetime(2026, 9, 21, 0, 0, 0)
    too_many = client.post(URL, headers=HDR, json={"device_id": DEV, "items": [
        {"ts": (base + timedelta(seconds=i)).strftime("%Y-%m-%d %H:%M:%S"),
         "channels": {"R": 1.0}} for i in range(5001)]})
    assert too_many.status_code == 422, f"超上限应 422，实际 {too_many.status_code}"
    assert "最多" in too_many.text, too_many.text[:200]
    assert len(rows()) == 4, "超上限的批次不能写进任何一条"
    print("[OK] 参数校验（未知通道 / 非数字 / 缺字段 / 超上限 → 422）")

    # 7) 连通性自检：不发数据也能验 URL + 令牌
    ok = client.get("/api/ingest/check", params={"device_id": DEV}, headers=HDR)
    assert ok.status_code == 200 and ok.json()["ok"] is True, ok.text
    assert client.get("/api/ingest/check", params={"device_id": DEV}).status_code == 401
    print("[OK] 连通性自检 /api/ingest/check")

    # 8) 未配置令牌时整个入口关闭（503），不能成为敞开的写入口
    from config import settings

    original = settings.ingest_tokens
    try:
        settings.ingest_tokens = ""
        assert client.post(URL, json=body, headers=HDR).status_code == 503
        print("[OK] 未配置令牌 → 503（入口默认关闭）")
    finally:
        settings.ingest_tokens = original

    # 9) 实测优先 + 缺通道补齐：接入硬件后**不能整台停掉模拟**，
    #    否则硬件只报温湿度时，位移/倾角/雨量/含水率会一起断供、曲线断崖。
    #    正确口径是按通道分工：硬件推过的通道归硬件，其余由同口径序列继续补。
    import asyncio

    from services.ingest import hardware_channels, is_hardware_device, poll_all

    assert is_hardware_device(DEV) is True, "收到推送后必须标记为真实硬件"
    owned = hardware_channels(DEV)
    assert owned == {"R", "D", "RN"}, owned          # 本用例推过 R / D / RN
    rest = asyncio.run(poll_all())
    assert DEV in rest, "硬件只覆盖部分通道时，其余通道不能跟着断供"
    assert not (owned & set(rest[DEV])), f"硬件负责的通道不能被补齐覆盖：{rest[DEV]}"
    assert {"P", "T", "H", "S"} <= set(rest[DEV]), f"缺的通道必须补齐：{rest[DEV]}"
    # 补齐序列给的是 8 个**可模拟**的通道：R/P/T/H / RN 雨量感应% / RNM 降雨mm / S / D。
    # 不含 DIST（原始测距）—— 那是激光/ToF 模块的实测值，模拟器不伪造它；
    # 也因此"实测通道 0/9"里会把 DIST 算成缺，这一点在运维页是如实显示的。
    assert len(rest["slope-node-02"]) == 8, "没接入硬件的设备照常补齐全通道"
    print("[OK] 实测优先 + 缺通道补齐：硬件负责的通道不补，其余照补")

    print("\nP13 硬件接入接口测试通过")


if __name__ == "__main__":
    main()
