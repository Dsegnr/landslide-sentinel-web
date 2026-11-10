"""管理人员接口（需要 admin token，只有密钥入口能拿到）。"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from config import settings
from database import (Alert, AuditLog, Prediction, SensorReading, SessionLocal,
                      User, get_db)
from services.auth import Principal, require_admin
from services.broadcast import broadcaster
from services.device_manager import manager
from services.reservoir import summary as level_summary
from services.timeutil import iso_utc

router = APIRouter(prefix="/api/admin", tags=["admin"])
STARTED_AT = datetime.now(timezone.utc)


def _count(db: Session, model) -> int:
    return int(db.execute(select(func.count()).select_from(model)).scalar_one())


@router.get("/overview")
def overview(principal: Principal = Depends(require_admin),
             db: Session = Depends(get_db)) -> dict:
    """管理后台首页：数据规模、告警状态、实时推送连接数、运行时长。"""
    stations = {d.station_id for d in manager.all() if d.station_id}
    return {
        "now": iso_utc(datetime.now(timezone.utc)),
        "uptime_seconds": int((datetime.now(timezone.utc) - STARTED_AT).total_seconds()),
        "devices": [{"device_id": d.device_id, "name": d.name, "mode": d.mode} for d in manager.all()],
        "counts": {
            "readings": _count(db, SensorReading),
            "predictions": _count(db, Prediction),
            "alerts": _count(db, Alert),
            "users": _count(db, User),
            "audit_logs": _count(db, AuditLog),
        },
        "alerts": {
            "open": int(db.execute(select(func.count()).select_from(Alert)
                                   .where(Alert.status == "open")).scalar_one()),
            "acked": int(db.execute(select(func.count()).select_from(Alert)
                                    .where(Alert.status == "acked")).scalar_one()),
            "cleared": int(db.execute(select(func.count()).select_from(Alert)
                                      .where(Alert.status == "cleared")).scalar_one()),
        },
        "reservoir": [level_summary(s) for s in sorted(stations)],
        "ws_clients": broadcaster.client_count,
        "database": _db_size_mb(),
        "operator": principal.name,
    }


@router.get("/audit")
def audit(limit: int = 50, principal: Principal = Depends(require_admin),
          db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        select(AuditLog).order_by(AuditLog.ts.desc()).limit(max(1, min(limit, 500)))
    ).scalars().all()
    return {"count": len(rows), "items": [{
        "ts": iso_utc(r.ts), "action": r.action, "target": r.target,
        "detail": r.detail, "by": r.user_email,
    } for r in rows]}


@router.get("/users")
def users(principal: Principal = Depends(require_admin),
          db: Session = Depends(get_db)) -> dict:
    rows = db.execute(select(User)).scalars().all()
    return {"count": len(rows), "items": [
        {"username": r.email, "name": r.name, "role": r.role, "active": r.is_active}
        for r in rows]}


def _db_size_mb() -> float | None:
    if not settings.database_url.startswith("sqlite"):
        return None
    path = Path(settings.database_url.replace("sqlite:///", ""))
    if not path.exists():
        return None
    return round(path.stat().st_size / 1024 / 1024, 2)
