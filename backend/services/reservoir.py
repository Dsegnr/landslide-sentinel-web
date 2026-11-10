"""库水位数据源：读取、按日对齐、导入。

库水位是**外部水文数据**（水文站/水库调度），不是硬件通道，因此独立存在
`reservoir_levels` 表里，设备通过 `station_id` 关联（见 device_manager）。

对齐口径（必须与算法侧一致，否则线上线下的 `draw_7/30/90` 会不一样）：
  * 按**自然日**精确对齐到读数序列；
  * **内部缺口**：只补 3 天以内，用与算法侧完全相同的
    `interpolate(limit=3, limit_area="inside")`（不要额外叠 ffill，那等于"填 6 天"）；
  * **末端滞后**：水文数据通常晚一天到，当天的读数没有当天水位。这时用
    "最近一次观测值保持"，上限同样是 3 天；超过 3 天就保持缺失，
    让模型退回哨兵模式（宁可报保守，也不能拿过期水位驱动 `draw` 特征）；
  * 长缺口一律不填——**不编数据**。
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from sqlalchemy import select

from database import ReservoirLevel, SessionLocal

log = logging.getLogger("sentinel.reservoir")

MAX_FILL_DAYS = 3

# 水位站摘要缓存：大屏每 30 秒轮询一次、每台设备都要查，
# 而水位本身是**日尺度**数据——缓存 10 秒完全不影响观感，
# 却能把"每个请求 4 次全表扫描"降到接近 0（并发能力的关键）。
_STATE_CACHE: dict[str, tuple[float, dict]] = {}
STATE_TTL_SECONDS = 10.0


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _day_key(series: pd.Series) -> pd.Series:
    """统一成"UTC 自然日"的无时区日界。

    坑：接口传进来的 `ts` 可能带时区（例如 `...Z`），而 SQLite 取出来的时间是裸时间，
    直接做 map 会**一条都匹配不上**，模型就悄悄退回哨兵模式——症状是"接入了水位却没有概率"。
    所以这里强制把两边都归一到 UTC 日的无时区时间戳。
    """
    key = pd.to_datetime(series)
    if getattr(key.dt, "tz", None) is not None:
        key = key.dt.tz_convert("UTC").dt.tz_localize(None)
    return key.dt.normalize()


def load_levels(station_id: str, days: int = 800) -> pd.Series:
    """返回该站的日水位序列，index = 自然日（Timestamp，UTC 日界），value = 米。"""
    db = SessionLocal()
    try:
        since = _naive(datetime.now(timezone.utc)) - timedelta(days=days)
        rows = db.execute(
            select(ReservoirLevel)
            .where(ReservoirLevel.station_id == station_id, ReservoirLevel.ts >= since)
            .order_by(ReservoirLevel.ts)
        ).scalars().all()
    finally:
        db.close()
    if not rows:
        return pd.Series(dtype="float64")
    index = _day_key(pd.Series([r.ts for r in rows]))
    s = pd.Series([r.level_m for r in rows], index=index, dtype="float64")
    return s[~s.index.duplicated(keep="last")].sort_index()


def attach_level(df: pd.DataFrame, station_id: str | None,
                 max_fill_days: int = MAX_FILL_DAYS) -> pd.DataFrame:
    """把库水位按自然日贴到读数序列上，生成模型需要的 `level` 列。"""
    if df is None or df.empty or not station_id:
        return df
    levels = load_levels(station_id)
    if levels.empty:
        return df
    out = df.copy()
    key = _day_key(out["ts"])
    out["level"] = key.map(levels)
    # 与算法侧 build_features 完全相同的补缺规则：**一次** interpolate(limit=3, limit_area="inside")。
    # 不要在这里再叠一个 ffill——那等于"填 6 天"，线上线下特征就对不上了。
    out["level"] = out["level"].interpolate(limit=max_fill_days, limit_area="inside")
    # 末端滞后：读数比水位新的时候，用最近一次观测值保持（≤ max_fill_days 天）
    last_obs = levels.index.max()
    lag_days = (key - last_obs).dt.days
    hold = (lag_days > 0) & (lag_days <= max_fill_days)
    if bool(hold.any()):
        out.loc[hold, "level"] = float(levels.iloc[-1])
    return out


def level_lag_days(station_id: str, until: datetime | None = None) -> int | None:
    """水位相对某天滞后几天（None 表示没有数据）。大屏用它标注"滞后 N 天"。"""
    series = load_levels(station_id)
    if series.empty:
        return None
    target = _naive(until or datetime.now(timezone.utc))
    return int((pd.Timestamp(target).normalize() - series.index.max()).days)


def upsert_levels(station_id: str, points, source: str = "csv") -> dict:
    """幂等写入：同一站同一天已存在则更新数值，不存在则新增。"""
    _STATE_CACHE.pop(station_id, None)      # 导入后立刻失效，避免读到旧摘要
    db = SessionLocal()
    inserted = updated = 0
    try:
        existing = {
            r.ts: r for r in db.execute(
                select(ReservoirLevel).where(ReservoirLevel.station_id == station_id)
            ).scalars().all()
        }
        for ts, level in points:
            t = _naive(pd.to_datetime(ts).to_pydatetime())
            value = float(level)
            row = existing.get(t)
            if row is None:
                db.add(ReservoirLevel(station_id=station_id, ts=t, level_m=value, source=source))
                inserted += 1
            elif abs(float(row.level_m) - value) > 1e-9:
                row.level_m = value
                row.source = source
                updated += 1
        db.commit()
    finally:
        db.close()
    return {"inserted": inserted, "updated": updated}


def import_csv(path: str | Path, station_id: str, source: str = "csv") -> dict:
    """导入两列 CSV/TSV：`日期,水位(m)`。表头、空行、坏行自动跳过。"""
    points = []
    skipped = 0
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            parts = [p.strip() for p in raw.replace("\t", ",").replace(";", ",").split(",")]
            if len(parts) < 2:
                skipped += 1
                continue
            try:
                ts = pd.to_datetime(parts[0])
                level = float(parts[1])
            except (ValueError, TypeError):
                skipped += 1                      # 表头等
                continue
            points.append((ts, level))
    result = upsert_levels(station_id, points, source=source)
    result["skipped"] = skipped
    result["station_id"] = station_id
    log.info("导入库水位 %s：新增 %s 更新 %s 跳过 %s",
             station_id, result["inserted"], result["updated"], skipped)
    return result


def latest(station_id: str) -> ReservoirLevel | None:
    db = SessionLocal()
    try:
        return db.execute(
            select(ReservoirLevel).where(ReservoirLevel.station_id == station_id)
            .order_by(ReservoirLevel.ts.desc()).limit(1)
        ).scalars().first()
    finally:
        db.close()


def summary(station_id: str) -> dict:
    """给 /api/devices 与健康检查用的一行摘要。"""
    info = station_state(station_id)
    return {
        "station_id": station_id,
        "n": info["n"],
        "latest_ts": info["latest_ts"],
        "latest_m": info["latest_m"],
    }


def station_state(station_id: str, ttl: float = STATE_TTL_SECONDS) -> dict:
    """(天数, 最新水位, 最新日期, 滞后天数) —— 带 TTL 缓存，一次查库算齐。

    以前 `_level_state()` 里 `load_levels()` 和 `level_lag_days()` 各查一次全表，
    一台设备一次请求就是 2 次全表扫描；并发一上来全部堵在磁盘/连接池上。
    """
    now = time.time()
    cached = _STATE_CACHE.get(station_id)
    if cached and now - cached[0] < ttl:
        return cached[1]

    s = load_levels(station_id)
    if s.empty:
        info = {"n": 0, "latest_ts": None, "latest_m": None, "lag_days": None}
    else:
        today = pd.Timestamp(_naive(datetime.now(timezone.utc))).normalize()
        info = {
            "n": int(len(s)),
            "latest_ts": str(s.index[-1])[:10],
            "latest_m": float(s.iloc[-1]),
            "lag_days": int((today - s.index.max()).days),
        }
    _STATE_CACHE[station_id] = (now, info)
    return info

