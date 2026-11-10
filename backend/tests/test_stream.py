"""P6 测试：WebSocket 实时推送。

分两层：
  1. 广播器单元测试（订阅/退订/队列满时丢最旧）——确定性，不依赖事件循环时序；
  2. 端到端：HTTP 上"确认告警" -> 广播 -> WebSocket 收到 `alert_ack`，
     并验证 `?device_id=` 过滤真的生效（先用不匹配的设备发一条，再发匹配的，
     收到的必须是匹配那条，否则说明过滤没做）。

运行：cd web/backend && python tests/test_stream.py
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from database import Alert, SessionLocal, init_db  # noqa: E402
from services.broadcast import MAX_QUEUE, Broadcaster  # noqa: E402


def make_alert(device_id: str) -> int:
    db = SessionLocal()
    try:
        row = Alert(device_id=device_id, ts=datetime.now(timezone.utc).replace(tzinfo=None),
                    level=3, stage="高度预警", reason="WS 测试", status="open")
        db.add(row)
        db.commit()
        db.refresh(row)
        return int(row.id)
    finally:
        db.close()


def test_broadcaster() -> None:
    async def run() -> None:
        b = Broadcaster()
        q1, q2 = b.subscribe(), b.subscribe()
        assert b.client_count == 2
        b.publish_nowait({"type": "reading", "device_id": "d1"})
        assert (await q1.get())["device_id"] == "d1"
        assert (await q2.get())["device_id"] == "d1"
        b.unsubscribe(q2)
        assert b.client_count == 1

        # 队列满时丢最旧的，绝不阻塞采集
        for i in range(MAX_QUEUE + 10):
            b.publish_nowait({"type": "reading", "n": i})
        assert q1.qsize() == MAX_QUEUE
        first = await q1.get()
        assert first["n"] == 10, f"应丢最旧的 10 条，实际首条是 {first}"
        b.unsubscribe(q1)
        assert b.client_count == 0

    asyncio.run(run())
    print(f"广播器 -> 订阅/退订/满队列丢最旧 OK（容量 {MAX_QUEUE}）")


def test_end_to_end(client, admin) -> None:
    assert client.get("/api/stream/status").json() == {"ok": True, "clients": 0}, "初始无连接"

    with client.websocket_connect(client.url_with_token("/ws/stream")) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["device_filter"] is None, hello
        assert client.get("/api/stream/status").json()["clients"] == 1

        alert_id = make_alert("ws-probe-node")
        assert admin.post(f"/api/alerts/{alert_id}/ack").status_code == 200
        event = ws.receive_json()
        assert event["type"] == "alert_ack" and event["alert_id"] == alert_id, event
        assert event["device_id"] == "ws-probe-node" and event["by"] == "admin"
        print("HTTP 确认告警 -> WebSocket 收到：", event)

    assert client.get("/api/stream/status").json()["clients"] == 0, "断开后应释放连接"

    # 过滤：只订阅 A 设备，A、B 各触发一次，收到的必须是 A 那条
    with client.websocket_connect(client.url_with_token("/ws/stream?device_id=filter-node-a")) as ws:
        hello = ws.receive_json()
        assert hello["device_filter"] == "filter-node-a", hello
        b_id = make_alert("filter-node-b")
        admin.post(f"/api/alerts/{b_id}/ack")
        a_id = make_alert("filter-node-a")
        admin.post(f"/api/alerts/{a_id}/ack")
        event = ws.receive_json()
        assert event["alert_id"] == a_id, f"device_id 过滤失效：收到 {event}"
        print(f"device_id 过滤 -> 只收到本设备事件（alert_id={a_id}）")


def main() -> None:
    init_db()
    test_broadcaster()

    from main import app
    with TestClient(app) as raw:
        client = authed_client(raw)
        admin = authed_client(raw, admin=True)
        test_end_to_end(client, admin)
    print("P6 WebSocket 推送测试通过")


if __name__ == "__main__":
    main()
