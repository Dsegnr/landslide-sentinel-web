"""硬件数据接入接口：通信模块（DTU / 4G / NB-IoT / ESP32）把读数推到服务器。

与其余 `/api/*` 接口的区别：这里**不用人机账号的 JWT**，而是每台设备一个令牌
（请求头 `X-Device-Token`）——硬件侧不该拿到我们的登录账号，令牌也能单独吊销。

落库后自动进既有链路：WebSocket 推大屏 → 触发推理与告警。
"""
from __future__ import annotations

import secrets
import logging
from datetime import datetime

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from config import settings
from services.device_manager import manager
from services.ingest import IngestError, ingest_points

router = APIRouter(prefix="/api/ingest", tags=["ingest"])
log = logging.getLogger(__name__)


class Sample(BaseModel):
    """一个采样点：时间戳 + 若干通道（没接的通道可以省略）。"""

    ts: datetime
    channels: dict[str, float | None] = Field(default_factory=dict)


class ReadingPayload(BaseModel):
    """单条用 ts+channels；批量用 items（两者都可，items 优先）。"""

    device_id: str
    ts: datetime | None = None
    channels: dict[str, float | None] | None = None
    items: list[Sample] | None = None


def _check_token(device_id: str, token: str) -> None:
    """按设备校验令牌：未配置该入口直接 503，令牌不对 401。

    **未知设备也返回 401（与令牌错误同码同文案）**：否则手持一个有效令牌就能靠
    404/401 的差异枚举"哪些 device_id 已登记"。真实原因只写服务端日志。
    """
    tokens = settings.ingest_token_map
    if not tokens:
        raise HTTPException(status_code=503,
                            detail="服务器未启用硬件接入（未配置 INGEST_TOKENS）")
    expected = tokens.get(device_id)
    if not expected or not secrets.compare_digest(token or "", expected):
        log.warning("设备接入被拒：device_id=%s（%s）",
                    device_id, "未登记该设备" if not expected else "令牌不匹配")
        raise HTTPException(status_code=401, detail="设备令牌无效")


@router.post("/readings")
async def push_readings(payload: ReadingPayload,
                        request: Request,
                        x_device_token: str = Header(default="")) -> dict:
    """接收硬件推送的读数（单条或批量），幂等落库并触发推理。"""
    _check_token(payload.device_id, x_device_token)
    if manager.get(payload.device_id) is None:
        # 同上：未知设备不给 404，改成与令牌错误同码同文案（防枚举），真实原因进日志
        log.warning("设备接入被拒：device_id=%s（已登记令牌但设备未在库中）", payload.device_id)
        raise HTTPException(status_code=401, detail="设备令牌无效")

    if payload.items:
        points = [{"ts": s.ts, "channels": s.channels} for s in payload.items]
    elif payload.ts is not None:
        points = [{"ts": payload.ts, "channels": payload.channels or {}}]
    else:
        raise HTTPException(status_code=422,
                            detail="需要提供 ts+channels（单条）或 items（批量）")
    try:
        # 记录来源 IP：设备换网/换卡/走不同出口时，这是最直接的线索
        remote = request.client.host if request.client else ""
        return await ingest_points(payload.device_id, points, remote=remote)
    except IngestError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/check")
async def check(x_device_token: str = Header(default=""),
                device_id: str = "") -> dict:
    """给硬件侧做连通性自检：URL + 令牌对不对，不发数据也能验。"""
    if not device_id:
        raise HTTPException(status_code=422, detail="需要带查询参数 device_id")
    _check_token(device_id, x_device_token)
    dev = manager.get(device_id)
    if dev is None:
        log.warning("自检被拒：device_id=%s（已登记令牌但设备未在库中）", device_id)
        raise HTTPException(status_code=401, detail="设备令牌无效")
    return {"ok": True, "device_id": device_id, "name": dev.name,
            "channels": dev.channels}
