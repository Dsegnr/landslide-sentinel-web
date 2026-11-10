"""把涌浪推演挂进轮询循环：让它成为一条**连续的物理量流**，而不只是按需计算器。

为什么必须这么做（2026-09-16 更正）：涌浪是我们的物理算法之一，它的输入本来就随
时间变化 —— 库水位在消落、监测位移在加速。把推演挂进轮询后：

  * 每个点位每轮算一次两档 → 取 `advisory.level`；
  * **同时写一条 `Prediction`**（`device_id = "wave:<site>"`）——告警引擎的
    "连续 N 次低于告警级别则自动解除"读的就是这张表，不写它才会变成关不掉的常驻告警；
  * 再走 `alert_engine.process()`：新建 / 升级 / 去重 / 自动解除，与设备告警同一套。

等级口径仍由 `wave.wave_advisory()` 决定：**只有「前提成立且域内」的档才有资格**。
给不出结论时 level=0（平静），不产生告警，但照样落 `Prediction`。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Prediction, SessionLocal
from services.alert_engine import engine as alert_engine
from services.ingest import PREDICTION_MIN_INTERVAL_SECONDS, load_series
from services.wave import WaveInput, estimate_full
from services.wave_presets import PRESETS, binding_map

log = logging.getLogger("sentinel.wave")

#: 监测速率口径：用最近 N 天的位移变化折算平均速率（m/s）
RATE_WINDOW_DAYS = 30


def monitored_speed(device_id: str) -> float | None:
    """该设备最近的位移平均速率（m/s）；取不到就返回 None（该情景不参与）。"""
    df = load_series(device_id, days=RATE_WINDOW_DAYS + 5)
    if df is None or len(df) < 3:
        return None
    d = df.dropna(subset=["disp"])
    if len(d) < 3:
        return None
    days = (pd.to_datetime(d["ts"].iloc[-1]) - pd.to_datetime(d["ts"].iloc[0])).total_seconds() / 86400
    if days <= 0:
        return None
    delta_mm = float(d["disp"].iloc[-1]) - float(d["disp"].iloc[0])
    return abs(delta_mm) / 1000.0 / (days * 86400.0)      # mm → m，天 → 秒


def evaluate_wave_site(db: Session, site_id: str, device_id: str | None = None,
                       ts: datetime | None = None) -> dict | None:
    """对一个点位跑一次涌浪推演 → 落 Prediction → 驱动告警引擎。"""
    preset = PRESETS.get(site_id)
    if preset is None:
        log.warning("未知涌浪点位 %s", site_id)
        return None
    ts = ts or datetime.now(timezone.utc)
    pseudo = f"wave:{site_id}"

    params = {k: v for k, v in preset.items()
              if k not in ("name", "note", "unconfirmed")}
    try:
        inp = WaveInput(**params)
    except TypeError as exc:
        log.warning("点位 %s 参数不合法：%s", site_id, exc)
        return None

    speed = monitored_speed(device_id) if device_id else None
    out = estimate_full(inp, monitored_speed_mps=speed)
    adv = out["advisory"]
    level = int(adv["level"]) if adv["level"] is not None else 0
    stage = {0: "平静", 1: "关注", 2: "预警", 3: "高度预警", 4: "警报"}[level]
    reason = (f"涌浪推演：{adv['usable_m']} m（{adv['basis']}）"
              if adv["status"] == "ok" else adv["reason"])

    prev = db.execute(
        select(Prediction).where(Prediction.device_id == pseudo)
        .order_by(Prediction.ts.desc()).limit(1)
    ).scalars().first()
    # 与设备路径同一套节流：等级没变且没到间隔就不重复落库（一天 1440 行纯属垃圾数据）；
    # 等级一变立即记录，保证告警可追溯。间隔内仍要返回结果用于推送。
    if prev is not None and prev.ts is not None and prev.combined_level == level:
        age = (ts.replace(tzinfo=None) - prev.ts).total_seconds()
        if age < PREDICTION_MIN_INTERVAL_SECONDS:
            return {**adv, "site_id": site_id, "level": level, "stage": stage,
                    "alert_action": "throttled", "alert_id": None}

    db.add(Prediction(device_id=pseudo, ts=ts.replace(tzinfo=None), p7=None, p30=None,
                      sentinel_level=0, sentinel_channels="",
                      forecast_level=level, combined_level=level, stage=stage))
    db.commit()
    decision = alert_engine.process(db, pseudo, level, stage, reason=reason,
                                    ts=ts.replace(tzinfo=None))
    return {**adv, "site_id": site_id, "level": level, "stage": stage,
            "alert_action": decision.action, "alert_id": decision.alert_id}


def evaluate_all_sites(binding_raw: str) -> dict[str, dict]:
    """按绑定表跑一遍所有点位（给 polling_loop 调用）。"""
    out: dict[str, dict] = {}
    bindings = binding_map(binding_raw)
    for device_id, site_id in bindings.items():
        db = SessionLocal()
        try:
            res = evaluate_wave_site(db, site_id, device_id)
            if res:
                out[site_id] = res
        except Exception as exc:                    # noqa: BLE001 - 轮询不能因单点异常退出
            log.exception("点位 %s 涌浪推演失败：%s", site_id, exc)
        finally:
            db.close()
    return out
