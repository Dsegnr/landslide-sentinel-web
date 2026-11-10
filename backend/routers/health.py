"""健康检查：部署后第一件事就是打这个接口。"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import settings
from database import get_db

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict:
    try:
        db.execute(text("SELECT 1"))
        db_ok, db_err = True, ""
    except Exception as exc:
        db_ok, db_err = False, str(exc)[:200]

    model_path = Path(settings.model_dir)
    models = sorted(p.name for p in model_path.glob("*.json")) if model_path.exists() else []

    return {
        "status": "ok" if db_ok else "degraded",
        "app": settings.app_name,
        "version": settings.version,
        "database": {
            "ok": db_ok,
            "error": db_err,
            "dialect": settings.database_url.split(":")[0],
        },
        "tuya": {"configured": settings.tuya_configured},
        "models": models,
    }
