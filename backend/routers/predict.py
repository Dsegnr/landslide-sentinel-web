"""预警推理接口。

POST /api/predict
  请求体可选两种形式之一：
    A) {"rows": [{"ts": "...", "disp": 8.1, "rain": 0.0, "level": 158.2}, ...]}
       —— 直接给一段序列（最少约 90 天才能算出 90 日特征）；
    B) {"device_id": "slope-node-01", "days": 180}
       —— 从数据库读最近 N 天读数；设备若关联了库水位站，自动带上水位走 full 模式。

  返回最后一天的完整预警结果，以及最近若干天的历史序列。
"""
from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException

from services.auth import Principal, current_principal
from services.device_manager import manager
from services.ingest import SENTINEL_RAW_DAYS, load_raw_series, load_series
from services.predictor import predictor

router = APIRouter(prefix="/api", tags=["predict"])


def _from_db(device_id: str, days: int) -> pd.DataFrame:
    """从库里组装推理输入：读数按日聚合，关联水位站则贴库水位。

    走的是和后台轮询**同一个** `load_series`，避免"接口算出来和定时任务算出来不一样"。
    """
    df = load_series(device_id, days=days)
    if df is None or df.empty:
        raise HTTPException(404, f"设备 {device_id} 在最近 {days} 天内没有读数")
    return df


@router.post("/predict")
def predict(payload: dict = Body(...),
            principal: Principal = Depends(current_principal)) -> dict:
    if "rows" in payload:
        df = pd.DataFrame(payload["rows"])
        raw_df = None
        device_id = payload.get("device_id", "")
        channel_cols = payload.get("channel_cols")
        mode = payload.get("mode")
    elif "device_id" in payload:
        device_id = payload["device_id"]
        df = _from_db(device_id, int(payload.get("days", 180)))
        # 哨兵层要用**未聚合**的原始读数算滚动窗口增量；取不到就退回日尺度口径
        raw_df = load_raw_series(device_id, days=SENTINEL_RAW_DAYS)
        channel_cols = None
        mode = None
    else:
        raise HTTPException(422, "需要提供 rows 或 device_id")

    if df.empty:
        raise HTTPException(422, "输入序列为空")
    for col in ("ts", "disp"):
        if col not in df.columns:
            raise HTTPException(422, f"输入缺少必需列：{col}")

    # 库水位：设备未接入（或整列都缺）时不传 level 列，自动降级为 sentinel_only
    if "level" in df.columns and df["level"].isna().all():
        df = df.drop(columns=["level"])

    series = predictor.predict_series(df, channel_cols=channel_cols, mode=mode,
                                      raw_df=raw_df)
    last = series[-1] if series else {}
    dev = manager.get(device_id) if device_id else None
    return {
        "device_id": device_id,
        "device_name": dev.name if dev else "",
        "device_mode": dev.mode if dev else last.get("mode", ""),
        "n_rows": len(series),
        "latest": last,
        "history": series[-min(len(series), 60):],
    }


@router.get("/predict/{device_id}")
def predict_device(device_id: str, days: int = 180,
                   principal: Principal = Depends(current_principal)) -> dict:
    return predict({"device_id": device_id, "days": days}, principal)
