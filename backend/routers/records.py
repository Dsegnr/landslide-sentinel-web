"""现场滑坡记录：列表（所有人可看）+ 新增（仅管理人员，带照片上传）。

照片**落盘**到 `settings.upload_dir`，文件名用随机 UUID（避免中文名/重名/穿越），
库里只存文件名；文件通过 `/uploads/<文件名>` 读取（大屏 img 标签直接用）。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from database import FieldRecord, get_db
from services.auth import Principal, current_principal, require_admin
from services.security import sniff_image_type
from services.timeutil import iso_utc

router = APIRouter(prefix="/api", tags=["records"])

ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_PHOTO_BYTES = 8 * 1024 * 1024


def _to_dict(r: FieldRecord) -> dict:
    return {
        "id": r.id, "point_name": r.point_name, "device_id": r.device_id,
        "level": r.level, "note": r.note,
        "photo_url": (f"/uploads/{r.photo}" if r.photo else None),
        "observed_at": iso_utc(r.observed_at), "created_by": r.created_by,
        "created_at": iso_utc(r.created_at),
    }


@router.get("/records")
def list_records(limit: int = 50, db: Session = Depends(get_db),
                 principal: Principal = Depends(current_principal)) -> dict:
    rows = db.execute(
        select(FieldRecord).order_by(FieldRecord.observed_at.desc())
        .limit(max(1, min(limit, 200)))
    ).scalars().all()
    return {"count": len(rows), "items": [_to_dict(r) for r in rows]}


@router.post("/records")
async def create_record(
    point_name: str = Form(...),
    level: str = Form("中度"),
    note: str = Form(""),
    device_id: str = Form(""),
    observed_at: str | None = Form(None),
    photo: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_admin),
) -> dict:
    """新增现场记录（管理人员）。照片可选；落盘 + 落库，刷新不丢。"""
    name = (point_name or "").strip()
    if not name:
        raise HTTPException(422, "点位名称不能为空")
    if len(name) > 64:
        raise HTTPException(422, "点位名称过长（≤64 字）")

    saved_name = ""
    if photo is not None and photo.filename:
        suffix = Path(photo.filename).suffix.lower()
        if suffix not in ALLOWED_IMAGE:
            raise HTTPException(422, f"照片格式不支持：{suffix}（支持 {', '.join(sorted(ALLOWED_IMAGE))}）")
        raw = await photo.read()
        if len(raw) > MAX_PHOTO_BYTES:
            raise HTTPException(422, "照片过大（≤8 MB）")
        sniffed = sniff_image_type(raw)
        if sniffed is None:
            raise HTTPException(422, "文件内容不是有效图片（改后缀也拦得住）")
        if sniffed == ".jpg" and suffix == ".jpeg":
            sniffed = ".jpeg"
        if sniffed != suffix:
            raise HTTPException(422, f"文件内容与扩展名不一致（内容像 {sniffed}）")
        upload_dir = Path(settings.upload_dir)
        upload_dir.mkdir(parents=True, exist_ok=True)
        saved_name = f"{uuid.uuid4().hex}{suffix}"
        (upload_dir / saved_name).write_bytes(raw)

    when = datetime.now(timezone.utc).replace(tzinfo=None)
    if observed_at:
        try:
            when = datetime.fromisoformat(observed_at.replace("Z", "")).replace(tzinfo=None)
        except ValueError:
            raise HTTPException(422, "观察时间格式应为 ISO8601，例如 2026-09-14T10:00")

    row = FieldRecord(point_name=name, device_id=device_id, level=level, note=note,
                      photo=saved_name, observed_at=when, created_by=principal.name)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"ok": True, "record": _to_dict(row)}


@router.delete("/records/{record_id}")
def delete_record(record_id: int, db: Session = Depends(get_db),
                  principal: Principal = Depends(require_admin)) -> dict:
    """删记录只解除引用，**不删照片文件**（历史留存，避免误删现场证据）。"""
    row = db.get(FieldRecord, record_id)
    if row is None:
        raise HTTPException(404, f"记录 {record_id} 不存在")
    db.delete(row)
    db.commit()
    return {"ok": True, "deleted": record_id}
