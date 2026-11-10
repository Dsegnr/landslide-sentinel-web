"""告警引擎：把分级结果转成可追踪的告警记录。

规则（与论文的四级口径一致）：
  * 只有 level >= MIN_ALERT_LEVEL（默认 2「预警」）才产生告警；0/1 级只记录推理结果；
  * **去重**：同一设备已有未处理告警且新级别不高于它时，只更新"最近出现时间"，不新建记录；
  * **升级**：新级别更高时，在原记录上升级并留痕（避免一次事件刷出多条告警）；
  * **自动解除**：连续 CLEAR_AFTER 次推理都低于告警级别时，把未处理告警置为 cleared。

设计取舍：把"连续 N 次低级别"判定放在数据库里（读最近 N 条预测）而不是内存计数器，
这样服务重启后状态不丢，也不会因进程重启误判解除。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Alert, AuditLog, Prediction
from services.notify import notify

log = logging.getLogger("sentinel.alerts")

MIN_ALERT_LEVEL = 2
COOLDOWN_HOURS = 6
CLEAR_AFTER = 3


@dataclass
class AlertDecision:
    action: str            # created | escalated | deduped | cleared | none
    alert_id: int | None
    level: int
    reason: str = ""


class AlertEngine:
    # 主入口
    def process(self, db: Session, device_id: str, level: int, stage: str,
                reason: str = "", ts: datetime | None = None) -> AlertDecision:
        ts = ts or datetime.now(timezone.utc)
        open_alert = self._latest_open(db, device_id)

        if level >= MIN_ALERT_LEVEL:
            if open_alert is None:
                a = Alert(device_id=device_id, ts=ts, level=level, stage=stage,
                          reason=reason, status="open")
                db.add(a)
                db.commit()
                db.refresh(a)
                self._audit(db, "alert_created", device_id, f"level={level}")
                log.warning("新建告警 device=%s level=%d %s", device_id, level, reason)
                notify("created", device_id, level, stage, reason)
                return AlertDecision("created", a.id, level, reason)

            if level > open_alert.level:
                old = open_alert.level
                open_alert.level = level
                open_alert.stage = stage
                open_alert.reason = (f"{open_alert.reason}；升级：{reason}"
                                     if open_alert.reason else reason)
                open_alert.ts = ts
                db.commit()
                self._audit(db, "alert_escalated", device_id, f"{old}->{level}")
                log.warning("告警升级 device=%s %d->%d", device_id, old, level)
                notify("escalated", device_id, level, stage, reason)
                return AlertDecision("escalated", open_alert.id, level, reason)

            # 同级或更低：去重（仅刷新时间）
            open_alert.ts = ts
            db.commit()
            return AlertDecision("deduped", open_alert.id, open_alert.level)

        # level < MIN_ALERT_LEVEL：可能满足解除条件
        if open_alert is not None and self._sustained_low(db, device_id):
            open_alert.status = "cleared"
            db.commit()
            self._audit(db, "alert_cleared", device_id, f"连续 {CLEAR_AFTER} 次低于告警级别")
            log.info("告警解除 device=%s alert_id=%s", device_id, open_alert.id)
            notify("cleared", device_id, level, stage, f"连续 {CLEAR_AFTER} 次低于告警级别")
            return AlertDecision("cleared", open_alert.id, level)
        return AlertDecision("none", None, level)

    # 查询
    @staticmethod
    def list_alerts(db: Session, status: str | None = None, limit: int = 100) -> list[Alert]:
        q = select(Alert).order_by(Alert.ts.desc()).limit(limit)
        if status:
            q = select(Alert).where(Alert.status == status).order_by(Alert.ts.desc()).limit(limit)
        return list(db.execute(q).scalars().all())

    @staticmethod
    def ack(db: Session, alert_id: int, by: str = "") -> bool:
        a = db.get(Alert, alert_id)
        if a is None:
            return False
        already = a.status == "acked"
        a.status = "acked"
        a.acked_by = by
        a.acked_at = datetime.now(timezone.utc)
        db.commit()
        if not already:
            # 处置动作必须留痕（谁、什么时候、哪条告警）。这里曾经漏写过，
            # 结果管理后台的"操作审计"里看不到确认记录。
            AlertEngine._audit(db, "alert_acked", a.device_id,
                               f"alert_id={alert_id} level={a.level}", actor=by)
        return True

    # 内部
    @staticmethod
    def _latest_open(db: Session, device_id: str) -> Alert | None:
        q = (select(Alert).where(Alert.device_id == device_id, Alert.status.in_(("open", "acked")))
             .order_by(Alert.ts.desc()).limit(1))
        return db.execute(q).scalars().first()

    @staticmethod
    def _sustained_low(db: Session, device_id: str) -> bool:
        """最近 CLEAR_AFTER 条预测是否都低于告警级别。"""
        q = (select(Prediction).where(Prediction.device_id == device_id)
             .order_by(Prediction.ts.desc()).limit(CLEAR_AFTER))
        rows = list(db.execute(q).scalars().all())
        return len(rows) >= CLEAR_AFTER and all(r.combined_level < MIN_ALERT_LEVEL for r in rows)

    @staticmethod
    def _audit(db: Session, action: str, target: str, detail: str = "",
               actor: str = "system") -> None:
        db.add(AuditLog(user_email=actor, action=action, target=target, detail=detail))
        db.commit()


engine = AlertEngine()
