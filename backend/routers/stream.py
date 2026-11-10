"""WebSocket 实时推送接口。

  GET /ws/stream[?device_id=xxx]  —— 订阅实时事件流（可选只看某台设备）
  GET /api/stream/status          —— 连接数统计（大屏顶栏与测试用）

事件类型：
  hello      接入确认（含当前连接数）
  reading    新读数
  prediction 新预警（等级 / 概率 / 是否触发告警）
  alert_ack  告警被确认
  ping       心跳（前端据此判断链路是否还活着）
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.broadcast import broadcaster
from services.auth import principal_from_token
from services.timeutil import iso_utc

log = logging.getLogger("sentinel.stream")
router = APIRouter(tags=["stream"])

HEARTBEAT_SECONDS = 30


@router.websocket("/ws/stream")
async def stream(websocket: WebSocket, device_id: str | None = None,
                 token: str | None = None) -> None:
    # 浏览器的 WebSocket 不能带请求头，所以走 query 传 token；
    # 未登录直接 1008（policy violation）拒绝，不给任何数据。
    principal = principal_from_token(token)
    if principal is None:
        await websocket.close(code=1008, reason="需要登录")
        return
    await websocket.accept()
    queue = broadcaster.subscribe()
    try:
        await websocket.send_json({
            "type": "hello",
            "ts": iso_utc(datetime.now(timezone.utc)),
            "clients": broadcaster.client_count,
            "device_filter": device_id,
        })
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping",
                                           "ts": iso_utc(datetime.now(timezone.utc))})
                continue
            if device_id and event.get("device_id") and event["device_id"] != device_id:
                continue
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception as exc:                       # noqa: BLE001 - 单连接异常不能影响服务
        log.warning("WebSocket 连接异常：%s", exc)
    finally:
        broadcaster.unsubscribe(queue)


@router.get("/api/stream/status")
def stream_status() -> dict:
    return {"ok": True, "clients": broadcaster.client_count}
