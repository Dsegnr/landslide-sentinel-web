"""进程内事件广播：把"新读数 / 新预警 / 告警变化"推给所有 WebSocket 连接。

为什么不用 Redis/Kafka：单机部署、数据量小（每台设备分钟级一条），
进程内广播够用且零依赖；真要多实例时再换消息中间件（见 README 的部署章节）。

约束：**推送绝不能拖慢采集**。队列满了就丢最旧的（实时看板只关心最新值），
采集与推送互不阻塞。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger("sentinel.broadcast")

MAX_QUEUE = 200


class Broadcaster:
    def __init__(self) -> None:
        self._queues: set[asyncio.Queue] = set()

    @property
    def client_count(self) -> int:
        return len(self._queues)

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUE)
        self._queues.add(queue)
        log.info("WebSocket 客户端接入，当前 %d 个连接", len(self._queues))
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._queues.discard(queue)
        log.info("WebSocket 客户端断开，当前 %d 个连接", len(self._queues))

    def publish_nowait(self, event: dict[str, Any]) -> None:
        for queue in list(self._queues):
            if queue.full():
                try:
                    queue.get_nowait()          # 丢最旧的，保证推送侧永不阻塞
                except asyncio.QueueEmpty:      # pragma: no cover - 竞态兜底
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:           # pragma: no cover
                log.warning("推送队列已满，丢弃事件 %s", event.get("type"))

    async def publish(self, event: dict[str, Any]) -> None:
        self.publish_nowait(event)


broadcaster = Broadcaster()
