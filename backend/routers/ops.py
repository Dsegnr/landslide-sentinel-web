"""设备与通信运维接口（第 4 个页面「设备与通信」）。

与其余接口的分工：`/api/devices`、`/api/sensors/*` 回答"数据是多少"，
这里回答"设备与链路怎么样" —— 令牌登记、上报时延、断连与补传、
逐通道健康度、每次推送的接入审计。

安全：所有接口都要登录（普通用户只读）。**任何接口都不返回令牌原文**，
只回答"登记 / 未登记"。
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from database import get_db
from services import ops
from services.auth import Principal, current_principal
from services.telemetry import reception_history

router = APIRouter(prefix="/api/ops", tags=["ops"])


@router.get("/quality/{device_id}")
def get_quality(device_id: str, hours: int = Query(24, ge=1, le=720),
                anchor: str = Query("latest", pattern="^(live|latest|at)$"),
                end: datetime | None = None, db: Session = Depends(get_db),
                principal: Principal = Depends(current_principal)) -> dict:
    from services.ops_quality import quality
    try:
        return quality(db, device_id, hours, anchor, end)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/telemetry/{device_id}")
def get_telemetry(device_id: str, hours: int = Query(1, ge=1, le=720),
                  anchor: str = Query("latest", pattern="^(live|latest|at)$"),
                  end: datetime | None = None, channels: str = "D",
                  db: Session = Depends(get_db),
                  principal: Principal = Depends(current_principal)) -> dict:
    """True hardware only; bounded server-time reception and sample-time charts."""
    try:
        return reception_history(db, device_id, hours, anchor, end, tuple(channels.split(",")))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/overview")
def get_overview(db: Session = Depends(get_db),
                 principal: Principal = Depends(current_principal)) -> dict:
    """接入总览：设备数、在线/停更/离线、24h 上报量、令牌登记情况。"""
    return ops.overview(db)


@router.get("/summary")
def get_summary(db: Session = Depends(get_db),
                principal: Principal = Depends(current_principal)) -> dict:
    """首屏一次取全：总览 + 设备台账 + 接入审计。

    为什么要有这个接口：页面进来原本并发打 3 个接口（外加当前所选设备的
    链路/通道/自检），走公网时每个请求有近 1 秒的固定往返，首屏就被拖到
    好几秒。这里只是把**已经存在的三个函数**合成一次调用——数值、口径、
    排序与各自单独调用时完全一致，`/overview`、`/devices`、`/events`
    三个接口原样保留，其它调用方不受影响。
    """
    # 这段与下面三个接口逐字对应：同一批函数、同样的包装结构与 limit
    # （devices 与 events 的返回体就是 {"count", "items"}）。
    inventory = ops.device_inventory(db)
    events = ops.events(db, limit=30)
    return {
        "overview": ops.overview(db),
        "devices": {"count": len(inventory), "items": inventory},
        "events": {"count": len(events), "items": events},
    }


@router.get("/devices")
def get_devices(db: Session = Depends(get_db),
                principal: Principal = Depends(current_principal)) -> dict:
    """设备台账 + 通信健康（每台一行）。"""
    items = ops.device_inventory(db)
    return {"count": len(items), "items": items}


@router.get("/link/{device_id}")
def get_link(device_id: str, hours: int = Query(72, ge=1, le=24 * 30),
             db: Session = Depends(get_db),
             principal: Principal = Depends(current_principal)) -> dict:
    """链路质量：上报时延分布、断连区间、补传识别（只算真实硬件推送）。"""
    return ops.link_quality(db, device_id, hours=hours)


@router.get("/channels/{device_id}")
def get_channels(device_id: str, hours: int = Query(24, ge=1, le=24 * 30),
                 db: Session = Depends(get_db),
                 principal: Principal = Depends(current_principal)) -> dict:
    """逐通道健康度：最后有值时间、窗口内条数、卡值/越界提示。"""
    items = ops.channel_health(db, device_id, hours=hours)
    return {"device_id": device_id, "hours": hours, "count": len(items),
            "items": items}


@router.get("/events")
def get_events(limit: int = Query(50, ge=1, le=200),
               db: Session = Depends(get_db),
               principal: Principal = Depends(current_principal)) -> dict:
    """接入审计：服务器每次收到推送的记录（条数 / 去重数 / 来源 IP）。"""
    items = ops.events(db, limit=limit)
    return {"count": len(items), "items": items}


@router.get("/selfcheck/{device_id}")
def get_selfcheck(device_id: str, request: Request,
                  principal: Principal = Depends(current_principal)) -> dict:
    """自检向导：接口地址、请求头、可直接复制的报文样例。"""
    base = str(request.base_url).rstrip("/")
    return ops.selfcheck(device_id, base_url=base)


@router.get("/security")
def get_security(db: Session = Depends(get_db),
                 principal: Principal = Depends(current_principal)) -> dict:
    """令牌与接入安全：登记状态、最近使用痕迹、来源 IP 变化、安全策略。

    **不返回令牌原文**，只回答"登记/未登记"与"用过没有"。
    """
    return ops.security(db)


@router.get("/system")
def get_system(db: Session = Depends(get_db),
               principal: Principal = Depends(current_principal)) -> dict:
    """系统运行态与维护：进程、磁盘、库体积、备份、模型、日志。"""
    return ops.system(db)


@router.get("/notify")
def get_notify(limit: int = Query(50, ge=1, le=200),
               db: Session = Depends(get_db),
               principal: Principal = Depends(current_principal)) -> dict:
    """通知与派发：渠道配置状态 + 最近的派发结果（不含 webhook 地址）。"""
    return ops.notify_status(db, limit=limit)


@router.post("/notify/test")
def post_notify_test(principal: Principal = Depends(current_principal)) -> dict:
    """发一条**同步**自检消息到已配置的渠道（运维按一下就知道通不通）。

    只在管理人员权限下允许 —— 它会真的往群里发消息，不该由只读用户触发。
    """
    if principal.role != "admin":
        raise HTTPException(403, "该操作需要管理人员权限")
    from services.notify import format_message, send_now

    ok, detail = send_now(format_message("created", "自检", 4, "警报",
                                         "来自「设备与通信」页的派发自检"))
    return {"ok": ok, "detail": detail}


@router.get("/baseline/{device_id}")
def get_baseline(device_id: str,
                 principal: Principal = Depends(current_principal)) -> dict:
    """读这台设备的安装基线（测距型位移用）：`位移 = 基线 − 原始测距`。"""
    from services.ingest import get_baseline as read_baseline

    info = read_baseline(device_id)
    return {"device_id": device_id, "baseline": info}


@router.post("/baseline/{device_id}")
def post_baseline(device_id: str, value: float | None = None,
                  principal: Principal = Depends(current_principal)) -> dict:
    """重新标定安装基线（现场换安装位置/换目标物之后用）。

    不传 `value` 时取**最近一条有效测距**当基线；只在管理人员权限下允许 ——
    它会让该设备的位移从 0 重新起算，属于会改变展示口径的操作。
    """
    if principal.role != "admin":
        raise HTTPException(403, "该操作需要管理人员权限")
    from services.ingest import IngestError, set_baseline

    try:
        info = set_baseline(device_id, value)
    except IngestError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "baseline": info}


@router.get("/completeness")
def get_completeness(hours: int = Query(72, ge=1, le=24 * 30),
                     db: Session = Depends(get_db),
                     principal: Principal = Depends(current_principal)) -> dict:
    """数据完整性：来源构成、通道覆盖矩阵、上报缺口区间。"""
    return ops.completeness(db, hours=hours)
