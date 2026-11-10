"""虚拟设备数据源（未配置涂鸦凭证时使用）。

与队长原版「每次轮询各自随机」的写法不同，本模块生成的读数**与库里最近一条读数连续**：

  * 位移按最近一段的实测速率推进（速率从历史估计，上限 30 mm/d），
    因此不会出现"上一条 25 mm、下一条 8 mm"的跳变把整段序列打断；
  * 雨量按天气过程给出**该采样周期内的降雨量**（速率 × 间隔），
    这样按日累加后与日尺度口径一致；
  * 温度/湿度带季节项与日变化，土壤含水率随降雨上升、无雨时指数衰减；
  * 倾角随位移速率小幅联动。

**本模块产生的全部是模拟数据**，接口返回 `is_demo=true`，答辩时必须如实说明。
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from config import settings
from database import SessionLocal, SensorReading
from services.device_manager import manager

MAX_DRIFT_MM_PER_DAY = 30.0        # 位移速率上限，防止估计值被离群点带飞
MAX_ELAPSED_DAYS = 1.0             # 停机很久后，只推进一天，避免一次性跳变
CHANNELS = ("R", "P", "T", "H", "RN", "RNM", "S", "D")


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _recent(device_id: str, days: int = 60, limit: int = 5000) -> list[SensorReading]:
    """取最近一段时间的读数（按**时间窗**取，不是按条数）。

    分钟级采样下"最近 30 条"只覆盖几十分钟，用来估速率会把噪声当成趋势。
    """
    db = SessionLocal()
    try:
        since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
        rows = db.execute(
            select(SensorReading)
            .where(SensorReading.device_id == device_id, SensorReading.ts >= since)
            .order_by(SensorReading.ts.desc()).limit(limit)
        ).scalars().all()
        return list(reversed(rows))
    finally:
        db.close()


def _last_known(rows: list[SensorReading]) -> dict[str, float]:
    """每个通道**最近一次非空值**，而不是"最后一行的值"。

    硬件只上报部分通道时，尾部会是一整段 None 的行。若拿 rows[-1] 当锚点，
    位移会退回默认的 8.0，补齐序列里就出现一次 40.9 → 8.0 的假跌落
    （实测踩过：硬件接入后位移曲线突然断崖）。
    """
    known: dict[str, float] = {}
    for row in reversed(rows):
        for ch in CHANNELS:
            if ch in known:
                continue
            value = getattr(row, ch, None)
            if value is not None:
                known[ch] = float(value)
        if len(known) == len(CHANNELS):
            break
    return known


def estimate_drift(rows: list[SensorReading], days: float = 30.0) -> float:
    """估计位移速率（mm/d）：取"最近 days 天"的两端差分，而不是最近 N 条读数。

    教训：早期版本拿最近 30 条读数算斜率，分钟级采样下这 30 条只跨几十分钟，
    噪声会被当成趋势、再撞上 30 mm/d 的上限，导致位移一天涨 2 mm、倾角顶到 45°。
    """
    pts = sorted(((_naive(r.ts), r.D) for r in rows if r.D is not None), key=lambda p: p[0])
    if len(pts) < 2:
        return 0.05
    t_last, v_last = pts[-1]
    target = t_last - timedelta(days=days)
    base_t, base_v = min(pts[:-1], key=lambda p: abs((p[0] - target).total_seconds()))
    span_days = (t_last - base_t).total_seconds() / 86400.0
    if span_days < 1.0:                       # 数据不足一天就退化为首尾两点，按天归一
        base_t, base_v = pts[0]
        span_days = max((t_last - base_t).total_seconds() / 86400.0, 1e-6)
    return max(0.0, min((v_last - base_v) / span_days, MAX_DRIFT_MM_PER_DAY))


def advance(device_id: str, elapsed_days: float | None = None,
            channels: set[str] | None = None) -> dict[str, float]:
    """生成一条与库里最近读数连续的模拟读数（不落库，落库由 ingest 负责）。

    `channels` 用来限制只生成其中几个通道——硬件已负责的通道不回传，
    这样同一条序列里一个通道只会有一个来源，不存在"真假抢同一个字段"。
    """
    rows = _recent(device_id)
    known = _last_known(rows)
    last = rows[-1] if rows else None
    now = _naive(datetime.now(timezone.utc))
    if elapsed_days is None:
        if last is not None:
            elapsed_days = max((now - _naive(last.ts)).total_seconds() / 86400.0, 0.0)
        else:
            elapsed_days = 1.0
    elapsed_days = min(elapsed_days, MAX_ELAPSED_DAYS)

    # 演示点用**标定好的固定速率**：等级是按这个速率标出来的，
    # 若改回"按历史估计"，30 天平均会把加速段摊薄、等级会自己往下漂（实测踩过）。
    dev = manager.get(device_id)
    fixed = getattr(dev, "drift_mm_per_day", None) if dev is not None else None
    drift = float(fixed) if fixed else estimate_drift(rows) * settings.virtual_speedup
    doy = now.timetuple().tm_yday
    hour = now.hour + now.minute / 60.0
    season = 1.0 + 0.6 * math.sin(2 * math.pi * (doy - 120) / 365)      # 雨季偏大

    # 降雨：按天气过程给"本周期降雨量"（mm）
    rain_rate = (max(0.0, random.gauss(12 * season, 8)) if random.random() < 0.25 * season
                 else 0.0)
    rain = rain_rate * elapsed_days

    # 雨量感应强度 %（0–100）：平面雨量传感器报的是**表面湿润程度**，不是 mm。
    # 口径 2026-09-23 拆分：mm 走 RNM（就是上面那个 rain），% 走 RN。
    # 这里把两者做成物理自洽的：正在下雨→接近饱和，雨停后按时间常数变干；
    # 无雨期维持一个干燥底值，避免整段恒为 0 被运维页当成"卡值"误报。
    prev_rn = known.get("RN", 0.0)
    rn_target = 100.0 if rain_rate > 0 else 8.0
    rn_alpha = 1 - math.exp(-elapsed_days / (0.15 if rain_rate > 0 else 1.2))
    rn_wet = prev_rn + (rn_target - prev_rn) * rn_alpha + random.gauss(0, 1.5)
    rn_wet = max(0.0, min(100.0, rn_wet))

    # 位移：延续最近速率（锚点取"最近一次有值的位移"，跳过硬件留下的空行）
    #
    # ⚠ 随机项**只在没有固定速率时**加。原因（2026-09-22 实测踩到）：
    #   轮询是每分钟一次，而这个 0.004 mm 的随机项**没有按经过时间缩放**，
    #   于是它变成了随机游走 —— 每分钟推 0.003 mm，一天就是 ~4.6 mm，
    #   把演示点标定好的 0.10 mm/d(≈0.00007 mm/min) 彻底淹没，
    #   种下去是 1 级、一分钟后就变成 0 级。
    #   固定速率的点必须走纯线性推进，否则标定的等级根本站不住。
    prev_d = known.get("D", 8.0)
    if fixed:
        disp = prev_d + drift * elapsed_days
    else:
        disp = prev_d + drift * elapsed_days + abs(random.gauss(0, 0.004))

    # 温度/湿度：季节 + 日变化
    temp = (20 + 8 * math.sin(2 * math.pi * (doy - 105) / 365)
            + 4 * math.sin(2 * math.pi * (hour - 9) / 24) + random.gauss(0, 0.4))
    hum = min(99.0, max(25.0, 78 - 0.8 * (temp - 20) + random.gauss(0, 2.5)))

    # 土壤含水率：随降雨上升，无雨衰减
    prev_s = known.get("S", 35.0)
    target_s = 30.0 + 0.6 * rain_rate + 8.0 * (season - 1.0)
    alpha = 1 - math.exp(-elapsed_days / 0.6)
    soil = prev_s + (target_s - prev_s) * alpha + random.gauss(0, 0.2)

    # 倾角：以"位移速率"为基线 + 本次增量的响应（**不做累加**）
    # 早期版本写成 prev_r + 1.5*(disp-prev_d)，每次服务重启后的跳变都会累进倾角，
    # 跑一天下来倾角会漂到十几度（与物理不符）。这里改成由速率决定的基线，
    # 倾角就不会随重启次数单向漂移。
    tilt_base = 1.0 + 2.0 * drift
    tilt = min(45.0, max(0.2, tilt_base + 1.5 * (disp - prev_d) + random.gauss(0, 0.03)))

    full = {
        "R": round(tilt, 3), "P": round(tilt * 0.95, 3),
        "T": round(temp, 2), "H": round(hum, 2),
        # RN = 感应强度 %（平面传感器口径）；RNM = 降雨量 mm（模型特征用的就是它）
        "RN": round(rn_wet, 2), "RNM": round(rain, 3),
        # 位移保留 5 位小数，**不能再粗**：轮询是每分钟一条，固定速率 0.15 mm/d
        # 折到每分钟只有 0.000104 mm —— 取整到 3 位（0.001）就把增量整个抹掉，
        # 位移从此长期不动（实测：演示点整天跨度 0.0000，等级跟着掉）。
        # 其他通道的增量由各自公式驱动、没有这个量级问题，维持原精度。
        "S": round(soil, 2), "D": round(disp, 5),
    }
    if channels is None:
        return full
    return {k: v for k, v in full.items() if k in channels}
