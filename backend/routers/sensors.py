"""设备与传感器数据接口（前端大屏用）。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from config import settings
from database import Alert, Device, Prediction, SensorReading, get_db
from services.device_manager import manager
from services.auth import Principal, current_principal
from services.ingest import ALLOWED_CHANNELS
from services.reservoir import attach_level, load_levels, station_state
from services.timeutil import iso_utc

router = APIRouter(prefix="/api", tags=["sensors"])

# "每个通道最近一次有值的读数" —— 一次查询取齐（见 _latest_by_channel 的注释）
_LATEST_BY_CHANNEL_SQL = text(" UNION ALL ".join(
    f"SELECT '{c}' AS ch, t.{c} AS val, t.ts AS ts, t.source AS source "
    f"FROM (SELECT {c}, ts, source FROM sensor_readings "
    f"WHERE device_id = :dev AND {c} IS NOT NULL ORDER BY ts DESC LIMIT 1) t"
    for c in ALLOWED_CHANNELS
))


def _level_state(dev) -> tuple[str, float | None, int, int | None]:
    """(运行模式, 最新水位, 水位天数, 滞后天数)。

    以"库里真有水位数据"为准，而不是只看设备声明——声明接入但水位表是空的，
    大屏就必须按哨兵模式显示，不能拿一个空的水位去骗人。
    """
    if not dev.station_id:
        return "sentinel_only", None, 0, None
    info = station_state(dev.station_id)      # 带 10 秒缓存，一次查齐（n/最新值/滞后）
    if not info["n"]:
        return "sentinel_only", None, 0, None
    return "full", info["latest_m"], info["n"], info["lag_days"]


def _latest_by_channel(db: Session, device_id: str) -> dict[str, tuple[float, datetime, str]]:
    """每个通道"最近一次有值的读数"（值 / 时间 / 来源）。

    不能只看最后一行：硬件只上报部分通道时，最后一行往往只有温湿度，
    位移会被读成空、大屏上直接变成"—"。按通道各取最近有值的一条，
    既能把实测与同口径补齐拼成一条完整读数，也能逐通道说清每个值的来路
    （`source`：hardware=实测 / simulation=补齐 / unknown=加列前的历史行）。
    """
    # 一次往返拿齐 7 个通道：每台设备原来要发 7 条小查询，设备一多大屏首屏就慢。
    # 写法是 7 个带 LIMIT 1 的子查询 UNION ALL —— SQLite 允许在 FROM 子查询里
    # 用 ORDER BY + LIMIT（不允许的是在复合查询的每个分支上挂 LIMIT）。
    # 通道名来自常量 ALLOWED_CHANNELS，不是外部输入，直接拼进 SQL 是安全的。
    return {
        row.ch: (row.val, row.ts, row.source or "unknown")
        for row in db.execute(_LATEST_BY_CHANNEL_SQL, {"dev": device_id}).all()
    }


@router.get("/devices")
def list_devices(db: Session = Depends(get_db),
                 principal: Principal = Depends(current_principal)) -> dict:
    """设备列表 + 每台的最新读数、最新预警、未处理告警数。"""
    # 数据来源要按"这台设备到底有没有真硬件"来分，判据只能是 devices 表的持久标记
    # （与 services/ingest.py 的 is_hardware_device 同一口径）。
    # 不能拿内存注册表里的 DeviceInfo.is_virtual 当准：它默认 True，且不落库，
    # 一旦硬件真接入，接口就会把真实设备说成演示；反过来掉线重启也不会回退。
    # 不在 devices 表里 = 从没收到过硬件推送 = 演示源。
    virtual_map = {
        row.device_id: bool(row.is_virtual)
        for row in db.execute(select(Device.device_id, Device.is_virtual)).all()
    }
    items = []
    for dev in manager.all():
        mode, level_m, level_days, level_lag = _level_state(dev)
        # 每条读数由"该通道最近一次有值的那一行"拼出来：硬件负责的通道取实测，
        # 其余通道取同口径补齐。整条读数因此不会因为硬件只报一两个通道而变空。
        chan = _latest_by_channel(db, dev.device_id)
        last_ts = db.execute(
            select(SensorReading.ts).where(SensorReading.device_id == dev.device_id)
            .order_by(SensorReading.ts.desc()).limit(1)
        ).scalar_one_or_none()
        pred = db.execute(
            select(Prediction).where(Prediction.device_id == dev.device_id)
            .order_by(Prediction.ts.desc()).limit(1)
        ).scalars().first()
        # 口径要分清：open = 未处理（等人处置）；acked = 已确认但未解除（仍在跟踪）。
        # 把两者一起算成"未处理"，大屏上就会出现"点了确认数字不变"的怪现象。
        open_alerts = db.execute(
            select(func.count()).select_from(Alert)
            .where(Alert.device_id == dev.device_id, Alert.status == "open")
        ).scalar_one()
        acked_alerts = db.execute(
            select(func.count()).select_from(Alert)
            .where(Alert.device_id == dev.device_id, Alert.status == "acked")
        ).scalar_one()
        items.append({
            "device_id": dev.device_id, "name": dev.name, "mode": mode,
            "lon": dev.lon, "lat": dev.lat,
            "station_id": dev.station_id,
            "has_level": mode == "full",
            "level_m": level_m, "level_days": level_days,
            "level_lag_days": level_lag,
            # 2026-09-22 修正：判据从"是否配置涂鸦"改为"该设备是否虚拟/模拟源"。
            # 硬件直连设备（devices.is_virtual=0，有真实读数）返回 False（真实数据）；
            # 没接入过硬件的设备返回 True。涂鸦通道是否启用不再等同于"是否演示"。
            "is_demo": virtual_map.get(dev.device_id, True),
            "latest_ts": iso_utc(last_ts) if last_ts else None,
            "reading": ({ch: (chan[ch][0] if ch in chan else None)
                         for ch in ALLOWED_CHANNELS} if chan else None),
            # 逐通道来源：前端据此把"实测"和"同口径补齐"分开写，不靠一句笼统的话
            "reading_sources": {ch: (chan[ch][2] if ch in chan else None)
                                for ch in ALLOWED_CHANNELS},
            "prediction": ({
                "combined_level": pred.combined_level, "stage": pred.stage,
                "sentinel_level": pred.sentinel_level, "forecast_level": pred.forecast_level,
                "p7": pred.p7, "p30": pred.p30, "ts": iso_utc(pred.ts),
                # False = 近 24 h 没有可用位移增量，等级未更新（**不是"平静"**），
                # 前端据此显示"数据不足"，不能显示"正常监测，无需动作"。
                "data_available": bool(getattr(pred, "data_available", True)),
            } if pred else None),
            "open_alerts": int(open_alerts),
            "acked_alerts": int(acked_alerts),
        })
    return {"count": len(items), "items": items,
            "tuya_configured": settings.tuya_configured}


@router.get("/sensors/{device_id}")
def sensor_history(device_id: str, days: int = 90, db: Session = Depends(get_db),
                   principal: Principal = Depends(current_principal)) -> dict:
    """某设备最近 N 天的读数序列 + 预警等级演进（前端曲线用）。"""
    dev = manager.get(device_id)
    if dev is None:
        raise HTTPException(404, f"未注册的设备：{device_id}")
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.execute(
        select(SensorReading).where(SensorReading.device_id == device_id,
                                    SensorReading.ts >= since,
                                    # 曲线画的是位移与雨量；硬件只报温湿度的行在这里没有可画的值，
                                    # 留着只会把位移线打断。它们照旧存在库里、也照旧出现在卡片上。
                                    or_(SensorReading.D.isnot(None),
                                        SensorReading.RN.isnot(None),
                                        SensorReading.RNM.isnot(None)))
        .order_by(SensorReading.ts)
    ).scalars().all()
    df = pd.DataFrame({
        "ts": [r.ts for r in rows],
        "R": [r.R for r in rows], "P": [r.P for r in rows], "T": [r.T for r in rows],
        "H": [r.H for r in rows], "RN": [r.RN for r in rows], "S": [r.S for r in rows],
        "RNM": [r.RNM for r in rows], "D": [r.D for r in rows],
    })
    if dev.station_id and not df.empty:
        df = attach_level(df, dev.station_id)
    preds = db.execute(
        select(Prediction).where(Prediction.device_id == device_id,
                                 Prediction.ts >= since)
        .order_by(Prediction.ts)
    ).scalars().all()
    return {
        "device_id": device_id, "days": days, "count": len(rows),
        "station_id": dev.station_id, "mode": _level_state(dev)[0],
        "items": [{
            "ts": iso_utc(r.ts), "R": r.R, "P": r.P, "T": r.T,
            "H": r.H, "RN": r.RN, "RNM": r.RNM, "S": r.S, "D": r.D,
            # 库水位按自然日对齐（只有关联了水位站才有值），前端曲线据此多画一条水位线
            "level": (None if not hasattr(r, "level") or pd.isna(r.level) else float(r.level)),
        } for r in df.itertuples(index=False)],
        "predictions": [{
            "ts": iso_utc(p.ts), "sentinel_level": p.sentinel_level,
            "forecast_level": p.forecast_level, "combined_level": p.combined_level,
            "stage": p.stage, "p7": p.p7, "p30": p.p30,
            "data_available": bool(getattr(p, "data_available", True)),
        } for p in preds],
    }
