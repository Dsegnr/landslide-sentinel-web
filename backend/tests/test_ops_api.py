"""P14 契约测试：设备与通信运维接口（/api/ops/*）。

覆盖：鉴权、总览、设备台账、链路质量、通道健康度、接入审计、自检向导。
关键的两条**安全/口径断言**：
  * 任何接口都不得返回令牌原文（连片段也不行）；
  * 上报一次读数后，接入审计表要真的多一条（端到端，不是只看表结构）。

运行：cd web/backend && python tests/test_ops_api.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, ensure_min_series, setup  # noqa: E402

setup(__file__)
os.environ["INGEST_TOKENS"] = "slope-node-01:tok-ops-01"

from fastapi.testclient import TestClient  # noqa: E402

from services.device_manager import DEFAULT_DEVICES  # noqa: E402

DEVICE = next(iter(DEFAULT_DEVICES))
TOKEN = "tok-ops-01"


def test_auth_required(raw: TestClient) -> None:
    for path in ("/api/ops/overview", "/api/ops/summary", "/api/ops/devices",
                 "/api/ops/events", f"/api/ops/channels/{DEVICE}",
                 f"/api/ops/link/{DEVICE}", f"/api/ops/selfcheck/{DEVICE}"):
        code = raw.get(path).status_code
        assert code == 401, f"{path} 未登录应 401，实际 {code}"
    print("[OK] 未登录 → 七个 ops 接口全部 401")


def test_overview_and_devices(client) -> None:
    body = client.get("/api/ops/overview").json()
    for key in ("devices", "hardware_devices", "online", "stale", "offline",
                "never", "registered_tokens", "readings_24h", "ingest_events_24h",
                "storage"):
        assert key in body, f"总览缺字段 {key}"
    assert body["devices"] >= 1
    # 库体积与增长：只报告不清理（清理走 scripts/prune_readings.py）
    st = body["storage"]
    for key in ("readings_total", "db_size_mb", "readings_per_day", "note"):
        assert key in st, f"storage 缺字段 {key}"
    assert st["readings_total"] >= 0

    dev = client.get("/api/ops/devices").json()
    assert dev["count"] == len(dev["items"]) >= 1
    item = dev["items"][0]
    for key in ("device_id", "name", "is_virtual", "hardware_marked",
                "token_registered", "declared_channels", "measured_channels",
                "missing_channels", "last_ts", "status", "n_24h"):
        assert key in item, f"台账缺字段 {key}"
    assert item["status"] in ("online", "stale", "offline", "never", "no_link")
    if not item["hardware_marked"]:
        assert item["status"] == "no_link", "模拟点不能被当作硬件离线"
    print(f"[OK] 总览 {body['devices']} 台；台账字段齐全（首台状态 {item['status']}）")


def test_no_token_leak(client) -> None:
    """令牌原文绝不能被任何 ops 接口吐回来。"""
    blob = ""
    for path in ("/api/ops/overview", "/api/ops/devices", "/api/ops/events",
                 f"/api/ops/selfcheck/{DEVICE}"):
        blob += client.get(path).text
    assert TOKEN not in blob, "ops 接口泄漏了令牌原文"
    assert TOKEN[:6] not in blob, "ops 接口泄漏了令牌片段"
    print("[OK] 令牌原文与片段都没有出现在任何 ops 接口的响应里")


def test_summary_matches_individual(client) -> None:
    """首屏合成接口的内容必须与三个子接口逐字一致。

    为什么专门测这条：页面首屏从"打三个接口"改成"打一个 /api/ops/summary"，
    省的是公网往返。合成的风险正是"合成之后口径变了"——这里直接与三个
    子接口的返回值做全等比较，任何人改动合成逻辑都会被当场拦住。
    """
    summary = client.get("/api/ops/summary").json()
    overview = client.get("/api/ops/overview").json()
    devices = client.get("/api/ops/devices").json()
    events = client.get("/api/ops/events?limit=30").json()
    assert summary["overview"] == overview, "总览与子接口不一致"
    assert summary["devices"] == devices, "设备台账与子接口不一致"
    assert summary["events"] == events, "接入审计与子接口不一致"
    assert summary["devices"]["count"] == len(summary["devices"]["items"]) >= 1
    print(f"[OK] /api/ops/summary 与三个子接口逐字一致"
          f"（{summary['devices']['count']} 台设备、{summary['events']['count']} 条审计）")


def test_link_and_channels(client) -> None:
    link = client.get(f"/api/ops/link/{DEVICE}?hours=72").json()
    for key in ("device_id", "hours", "n", "delay"):
        assert key in link, f"链路质量缺字段 {key}"
    assert "gaps" in link and "backfill" in link

    ch = client.get(f"/api/ops/channels/{DEVICE}?hours=24").json()
    assert ch["count"] == 9, ch
    names = [c["channel"] for c in ch["items"]]
    assert names == ["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"], names
    for c in ch["items"]:
        assert c["state"] in ("ok", "stuck", "out_of_range", "not_connected")
    # 无雨期 RNM（mm 雨量）连续 0.0 是正常状态，**不能**被报成卡值（实测踩过的假报警）
    rain = next(c for c in ch["items"] if c["channel"] == "RNM")
    assert rain["state"] != "stuck", "无雨期的连续 0.0 被误报为卡值"
    print(f"[OK] 链路质量（{link['n']} 条真实推送）；通道健康度 9 个通道"
          f"（RN=雨量感应%、RNM=雨量mm，无雨期的 0.0 未被误报为卡值）")


def test_selfcheck(client) -> None:
    sc = client.get(f"/api/ops/selfcheck/{DEVICE}").json()
    assert sc["device_id"] == DEVICE
    assert sc["token_registered"] is True, "测试环境已配置该设备令牌"
    assert set(sc["sample"]["channels"]) == set(DEFAULT_DEVICES[DEVICE].channels)
    assert "X-Device-Token" in sc["headers"]
    assert DEVICE in sc["endpoints"]["check"]
    # 动态检查时踩过：接口串里带着没替换的 {base} 占位符、还自带 GET/POST 前缀，
    # 页面上于是出现 `curl ... "GET {base}/api/..."` 和 `POST POST {base}/...`。
    for key, ep in sc["endpoints"].items():
        assert "{base}" not in ep, f"{key} 里还有没替换的 {{base}} 占位符：{ep}"
        assert ep.startswith("http"), f"{key} 不是完整地址：{ep}"
        assert not ep.upper().startswith(("GET ", "POST ")), f"{key} 自带方法前缀：{ep}"
    assert sc["base_url"] and not sc["base_url"].endswith("/")
    print(f"[OK] 自检向导：地址已拼全且无重复方法前缀（{sc['endpoints']['check']}）")


def test_ingest_event_recorded(raw: TestClient, client) -> None:
    """端到端：推一条读数进去，接入审计表必须多一条。"""
    before = client.get("/api/ops/events?limit=200").json()["count"]
    # 时间戳取"当前秒"（往前提一天），保证这条是新的：
    # 测试库是多个测试文件共享的，用固定 ts 会被幂等去重（accepted=0）——
    # 那本身是正确行为，但会让这条端到端断言测不到"写入"这一步。
    from datetime import datetime, timedelta, timezone
    ts = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    res = raw.post("/api/ingest/readings",
                   json={"device_id": DEVICE, "ts": ts,
                         "channels": {"R": 2.1, "D": 20.2}},
                   headers={"X-Device-Token": TOKEN})
    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 1, res.json()
    body = client.get("/api/ops/events?limit=200").json()
    assert body["count"] == before + 1, "上报后没有留下接入审计记录"
    latest = body["items"][0]
    assert latest["device_id"] == DEVICE and latest["accepted"] == 1
    print(f"[OK] 上报一次 → 接入审计新增一条（accepted={latest['accepted']}，"
          f"来源 {latest['remote']}）")


def main() -> None:
    ensure_min_series(DEVICE, days=40)
    from main import app
    with TestClient(app) as raw:
        client = authed_client(raw)
        test_auth_required(raw)
        test_overview_and_devices(client)
        test_no_token_leak(client)
        test_summary_matches_individual(client)
        test_link_and_channels(client)
        test_selfcheck(client)
        test_ingest_event_recorded(raw, client)
    print("\nP14 设备与通信运维接口测试通过")


if __name__ == "__main__":
    main()
