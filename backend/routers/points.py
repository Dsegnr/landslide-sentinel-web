"""地图点位：设备节点 + 人工警告点位（关注 / 权重）+ 区域加权风险。

权限沿用全局口径：**读取=登录用户，写入=管理人员**。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Prediction, WarningPoint, get_db
from services.auth import Principal, current_principal, require_admin
from services.device_manager import manager
from services.timeutil import iso_utc

router = APIRouter(prefix="/api", tags=["points"])

LEVEL_NAME = {0: "平静", 1: "关注", 2: "预警", 3: "高度预警", 4: "警报"}
MIN_WEIGHT, MAX_WEIGHT = 0.2, 3.0


class PointBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    level: int = Field(default=2, ge=0, le=4)
    weight: float = Field(default=1.0, ge=MIN_WEIGHT, le=MAX_WEIGHT)
    watch: bool = False
    note: str = ""


class PointPatch(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    level: int | None = Field(default=None, ge=0, le=4)
    weight: float | None = Field(default=None, ge=MIN_WEIGHT, le=MAX_WEIGHT)
    watch: bool | None = None
    note: str | None = None
    active: bool | None = None


def _to_dict(p: WarningPoint) -> dict:
    return {
        "id": p.id, "name": p.name, "lon": p.lon, "lat": p.lat,
        "level": p.level, "stage": LEVEL_NAME.get(p.level, ""),
        "weight": p.weight, "watch": p.watch, "note": p.note,
        "source": p.source, "active": p.active, "created_by": p.created_by,
        "created_at": iso_utc(p.created_at), "updated_at": iso_utc(p.updated_at),
    }


def _device_nodes(db: Session) -> list[dict]:
    """把设备也当成地图上的点位（带最新等级与最新读数）。"""
    nodes = []
    for dev in manager.all():
        if dev.lon is None or dev.lat is None:
            continue
        pred = db.execute(
            select(Prediction).where(Prediction.device_id == dev.device_id)
            .order_by(Prediction.ts.desc()).limit(1)
        ).scalars().first()
        level = pred.combined_level if pred else 0
        nodes.append({
            "id": f"device:{dev.device_id}", "device_id": dev.device_id,
            "name": dev.name, "lon": dev.lon, "lat": dev.lat,
            "level": level, "stage": LEVEL_NAME.get(level, ""),
            "weight": 1.0, "watch": False, "note": "", "source": "device",
            "active": True, "mode": dev.mode,
        })
    return nodes


def _summary(nodes: list[dict]) -> dict:
    """区域风险：加权平均等级 + 最高等级 + 关注点数。

    `weighted_score = Σ(level×weight) / Σ(weight)`，0~4 连续值；
    人工点位的权重越高，对区域风险的拉动越明显——这就是"权重"的用途。
    """
    active = [n for n in nodes if n["level"] > 0]
    total_w = sum(n["weight"] for n in active) or 1.0
    weighted = sum(n["level"] * n["weight"] for n in active) / total_w if active else 0.0
    max_level = max((n["level"] for n in active), default=0)
    return {
        "max_level": max_level,
        "max_stage": LEVEL_NAME.get(max_level, ""),
        "weighted_score": round(weighted, 3),
        "watch_count": sum(1 for n in nodes if n["watch"]),
        "manual_count": sum(1 for n in nodes if n["source"] == "manual"),
        "device_count": sum(1 for n in nodes if n["source"] == "device"),
        "level_counts": {LEVEL_NAME[i]: sum(1 for n in nodes if n["level"] == i) for i in range(5)},
    }


@router.get("/map/overview")
def map_overview(include_inactive: bool = False, db: Session = Depends(get_db),
                 principal: Principal = Depends(current_principal)) -> dict:
    """地图上要画的全部点位（设备 + 人工）+ 区域风险摘要。"""
    q = select(WarningPoint).order_by(WarningPoint.watch.desc(),
                                      WarningPoint.weight.desc(), WarningPoint.id.desc())
    if not include_inactive:
        q = q.where(WarningPoint.active.is_(True))
    manual = [_to_dict(p) for p in db.execute(q).scalars().all()]
    nodes = _device_nodes(db) + manual
    return {"count": len(nodes), "nodes": nodes, "manual": manual,
            "summary": _summary(nodes)}


@router.get("/points")
def list_points(db: Session = Depends(get_db),
                principal: Principal = Depends(current_principal)) -> dict:
    rows = db.execute(
        select(WarningPoint).order_by(WarningPoint.watch.desc(),
                                      WarningPoint.weight.desc(), WarningPoint.id.desc())
    ).scalars().all()
    return {"count": len(rows), "items": [_to_dict(p) for p in rows]}


@router.post("/points")
def create_point(body: PointBody, db: Session = Depends(get_db),
                 principal: Principal = Depends(require_admin)) -> dict:
    row = WarningPoint(name=body.name.strip(), lon=body.lon, lat=body.lat,
                       level=body.level, weight=body.weight, watch=body.watch,
                       note=body.note, source="manual", created_by=principal.name)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"ok": True, "point": _to_dict(row)}


@router.patch("/points/{point_id}")
def update_point(point_id: int, body: PointPatch, db: Session = Depends(get_db),
                 principal: Principal = Depends(require_admin)) -> dict:
    row = db.get(WarningPoint, point_id)
    if row is None:
        raise HTTPException(404, f"点位 {point_id} 不存在")
    data = body.model_dump(exclude_none=True)
    for key, value in data.items():
        setattr(row, key, value.strip() if isinstance(value, str) and key == "name" else value)
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(row)
    return {"ok": True, "point": _to_dict(row)}


@router.delete("/points/{point_id}")
def delete_point(point_id: int, db: Session = Depends(get_db),
                 principal: Principal = Depends(require_admin)) -> dict:
    row = db.get(WarningPoint, point_id)
    if row is None:
        raise HTTPException(404, f"点位 {point_id} 不存在")
    row.active = False          # 软删除：地图上不再显示，但历史仍在（可恢复）
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return {"ok": True, "deactivated": point_id}
