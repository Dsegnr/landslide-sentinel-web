"""告警查询与处置接口。"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Alert, get_db
from services.auth import Principal, current_principal, require_admin
from services.alert_engine import engine
from services.broadcast import broadcaster
from services.timeutil import iso_utc

router = APIRouter(prefix="/api", tags=["alerts"])


def _to_dict(a: Alert) -> dict:
    return {
        "id": a.id, "device_id": a.device_id, "ts": iso_utc(a.ts),
        "level": a.level, "stage": a.stage, "reason": a.reason,
        "status": a.status, "acked_by": a.acked_by,
        "acked_at": iso_utc(a.acked_at),
    }


@router.get("/alerts")
def list_alerts(status: str | None = None, limit: int = 100,
                db: Session = Depends(get_db),
                principal: Principal = Depends(current_principal)) -> dict:
    rows = engine.list_alerts(db, status=status, limit=limit)
    return {"count": len(rows), "items": [_to_dict(a) for a in rows]}


@router.post("/alerts/{alert_id}/ack")
async def ack_alert(alert_id: int, db: Session = Depends(get_db),
                    principal: Principal = Depends(require_admin)) -> dict:
    # 处置人取登录身份，不接受前端随便传（否则审计留痕没意义）
    by = principal.name
    alert = db.get(Alert, alert_id)
    if alert is None or not engine.ack(db, alert_id, by):
        raise HTTPException(404, f"告警 {alert_id} 不存在")
    # 其他正在看大屏的人要立刻看到这条告警被处置了
    await broadcaster.publish({
        "type": "alert_ack", "alert_id": alert_id, "device_id": alert.device_id,
        "by": by, "ts": iso_utc(datetime.now(timezone.utc)),
    })
    return {"ok": True, "alert_id": alert_id, "status": "acked", "by": by}
