"""设备数据接入：定时从涂鸦云拉取读数并落库。

无凭证时走模拟数据（tuya_client 内置），保证 P1→P4 全链路在拿到密钥前就能跑通。
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timedelta, timezone

import pandas as pd
from sqlalchemy import func, select, text

from config import settings
from database import (Alert, Device, DeviceBaseline, IngestEvent, Prediction,
                      SessionLocal, SensorReading)
from services.alert_engine import engine as alert_engine
from services.broadcast import broadcaster
from services.device_manager import manager
from services.predictor import predictor
from services.reservoir import attach_level
from services.timeutil import iso_utc
from services.tuya_client import TuyaClient, TuyaError
from services import virtual_device

log = logging.getLogger("sentinel.ingest")
client = TuyaClient()

# 推理落库节流：模型是**日尺度**的，等级没变化时没必要每分钟写一行
# （否则一天 1440 行/设备，MySQL 里纯属垃圾数据）；等级一变立即记录，保证告警可追溯。
PREDICTION_MIN_INTERVAL_SECONDS = 300

# 哨兵层滚动窗口（默认 24 h）需要的历史深度；留足余量以覆盖匹配容差与短缺口。
SENTINEL_RAW_DAYS = 10

# 硬件推送入口（通信模块 → 服务器）的约束
CN_TZ = timezone(timedelta(hours=8))          # 硬件/串口助手给的是北京时间
ALLOWED_CHANNELS = ("R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST")

# 通道量纲与取值范围（2026-09-23 定口径）：
#   RN  雨量感应强度 %（0–100）——平面雨量传感器给的是表面湿润程度，不是累计雨量
#   RNM 降雨量 mm（≥0）        ——留给能出毫米的雨量计；当前由同口径补齐序列填充
# 越界一律拒收，避免把"百分比"或"电压"这类值悄悄塞进雨量通道。
CHANNEL_RANGE: dict[str, tuple[float | None, float | None]] = {
    "RN": (0.0, 100.0),
    "RNM": (0.0, None),
}

# ---- 位移模块：现场报的是"原始测距 mm"，不是位移 ----------------------------------
# 口径（2026-09-23 与硬件负责人确认、并用原型自采数据核对过）：
#   * 传感器到目标物的**距离** ≈ 890 mm，遮挡/没打到目标时掉到几十毫米甚至个位数；
#   * 我们按 `位移 D = 基线 − DIST` 换算成**累计位移 mm**，基线 = 安装时的距离；
#   * 无效读数（超出量程）**只丢这一个通道**，不能因为测距无效把同一报文里的
#     温度/湿度也扔掉 —— 所以这里的越界处理与 RN 的"整条拒收"不同，见 normalize_channels。
DIST_MIN_VALID = 100.0        # 低于它基本是"没打到目标"（原型遮挡段实测 36 mm、个位数）
DIST_MAX_VALID = 6000.0       # 常见 ToF 量程上限（VL53L1X ~4 m），留一倍余量
MAX_BATCH_POINTS = 5000                       # 单次最多 5000 条，够离线补传


class IngestError(ValueError):
    """硬件推送的参数问题（由接口层转成 4xx，不当作 500 内部错误）。"""


def alert_reason(w: dict) -> str:
    """告警原因文案。

    台账与大屏都会显示这段文字，所以要能回答"是谁触发的"：
    只有硬件通道时报哨兵级与触发通道；接入库水位后还要报预警层等级与 7/30 天概率
    —— 否则出现"哨兵=0 却报了警报"（预警层触发）时没人看得懂。
    """
    channels = w.get("sentinel_channels") or []
    parts = [f"哨兵={w.get('sentinel_level')} 通道={'/'.join(channels) or '无'}"]
    if w.get("p30") is not None:
        p7 = w.get("p7")
        p7_txt = f"{p7:.1%}" if isinstance(p7, (int, float)) else "—"
        parts.append(f"预警层={w.get('forecast_level')} p7={p7_txt} p30={w['p30']:.1%}")
    return "｜".join(parts)


def save_reading(device_id: str, channels: dict[str, float],
                 ts: datetime | None = None,
                 source: str = "simulation") -> SensorReading:
    """把一次读数写入 sensor_readings，返回该行（供推送事件复用同一个时间戳）。

    `source` 必须由写入方显式声明：硬件推的写 'hardware'，补齐序列写 'simulation'。
    默认值取 'simulation' 是为了不让任何一条来路不明的行冒充实测。
    """
    db = SessionLocal()
    try:
        # 补齐/模拟这条路也要走同一套换算：万一某天模拟器或回放脚本给出 DIST，
        # 行为要与硬件推送完全一致（同一个函数、同一份基线）。
        channels = distance_to_displacement(db, device_id, dict(channels), {})
        row = SensorReading(
            device_id=device_id,
            ts=ts or datetime.now(timezone.utc),
            R=channels.get("R"), P=channels.get("P"), T=channels.get("T"),
            H=channels.get("H"), RN=channels.get("RN"), S=channels.get("S"),
            RNM=channels.get("RNM"), D=channels.get("D"),
            DIST=channels.get("DIST"),
            source=source,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    finally:
        db.close()


def to_utc_naive(ts: datetime) -> datetime:
    """统一成"不带时区的 UTC"（与库里既有读数口径一致）。

    不带时区的时间戳按**北京时间**解——硬件/串口助手给的就是本地时间，
    若当 UTC 处理会整体偏 8 小时，事件时刻就和曲线对不上。
    """
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=CN_TZ)
    return ts.astimezone(timezone.utc).replace(tzinfo=None)


def is_hardware_device(device_id: str) -> bool:
    """该设备是否已经接入真实硬件（收到过推送）。

    标记落在 `devices` 表里，是**持久**的：进程重启、机器重启都不会回退到模拟，
    否则一旦硬件掉线，模拟数据就会悄悄混进真实实验序列。
    """
    db = SessionLocal()
    try:
        row = db.execute(
            select(Device).where(Device.device_id == device_id)
        ).scalars().first()
        return row is not None and not row.is_virtual
    finally:
        db.close()


def mark_hardware_device(device_id: str) -> None:
    """把一台设备标记为"真实硬件"（首次收到推送时调用，幂等）。"""
    db = SessionLocal()
    try:
        row = db.execute(
            select(Device).where(Device.device_id == device_id)
        ).scalars().first()
        if row is None:
            dev = manager.get(device_id)
            db.add(Device(device_id=device_id, name=dev.name if dev else device_id,
                          sensor_type="hardware", is_virtual=False, status="online"))
        else:
            row.is_virtual = False
            row.status = "online"
        db.commit()
    finally:
        db.close()


def hardware_channels(device_id: str) -> set[str]:
    """这台设备的硬件**已经负责**哪些通道 = 它推送过的非空通道集合。

    补齐序列只写这里没有的通道。这样做的关键收益是：**一个通道永远只有一个来源**，
    既不会出现"真假读数混进同一条曲线"，也就不需要再定"谁优先"的规则。
    硬件以后补上位移通道，补齐会自动停掉位移——不用改任何配置。
    """
    db = SessionLocal()
    try:
        row = db.execute(text("""
            SELECT SUM(R IS NOT NULL), SUM(P IS NOT NULL), SUM(T IS NOT NULL),
                   SUM(H IS NOT NULL), SUM(RN IS NOT NULL), SUM(RNM IS NOT NULL),
                   SUM(S IS NOT NULL), SUM(D IS NOT NULL), SUM(DIST IS NOT NULL)
            FROM sensor_readings
            WHERE device_id = :dev AND source = 'hardware'
        """), {"dev": device_id}).fetchone()
    finally:
        db.close()
    if row is None:
        return set()
    return {ch for ch, n in zip(ALLOWED_CHANNELS, row) if n}


def normalize_channels(raw: dict) -> dict[str, float | None]:
    """只接受约定通道（R/P/T/H/RN/RNM/S/D/DIST）；未知字段直接报错，避免拼错后静默丢数据。"""
    unknown = sorted(k for k in raw if k not in ALLOWED_CHANNELS)
    if unknown:
        raise IngestError(f"未知通道 {unknown}；允许的通道：{list(ALLOWED_CHANNELS)}")
    out: dict[str, float | None] = {}
    for key in ALLOWED_CHANNELS:
        value = raw.get(key)
        if value is None or value == "":
            out[key] = None
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise IngestError(f"通道 {key} 的值不是数字：{value!r}")
        if not math.isfinite(number):
            raise IngestError(f"通道 {key} 的值不是有限数：{value!r}")
        low, high = CHANNEL_RANGE.get(key, (None, None))
        if low is not None and number < low:
            raise IngestError(f"通道 {key} 的值 {number} 小于下限 {low}")
        if high is not None and number > high:
            raise IngestError(
                f"通道 {key} 的值 {number} 超过上限 {high}"
                + ("（该通道是百分比，若你手里是毫米雨量，请走 RNM）" if key == "RN" else ""))
        out[key] = number
    return out


# ---- 位移模块：原始测距 → 累计位移 ----------------------------------------------

def get_baseline(device_id: str) -> dict | None:
    """读这台设备的安装基线（mm）。没有基线说明还没收到过有效测距。"""
    db = SessionLocal()
    try:
        row = db.get(DeviceBaseline, device_id)
        if row is None:
            return None
        return {"device_id": device_id, "baseline_mm": float(row.baseline_mm),
                "set_at": iso_utc(row.set_at), "source": row.source, "note": row.note}
    finally:
        db.close()


def set_baseline(device_id: str, value: float | None = None,
                 source: str = "manual", note: str = "") -> dict:
    """标定/重标安装基线。`value=None` 时取**最近一条有效测距**当基线。

    什么时候用：换安装位置、换目标物、或现场复核发现位移整体偏移时，
    在那之后重新标一次，位移从 0 重新累计（历史行不动，保持可追溯）。
    """
    db = SessionLocal()
    try:
        if value is None:
            last = db.execute(
                select(SensorReading.DIST)
                .where(SensorReading.device_id == device_id,
                       SensorReading.DIST.isnot(None),
                       SensorReading.DIST >= DIST_MIN_VALID,
                       SensorReading.DIST <= DIST_MAX_VALID)
                .order_by(SensorReading.ts.desc()).limit(1)
            ).scalar_one_or_none()
            if last is None:
                raise IngestError("这台设备还没有有效测距，无法据此标定；请显式给一个基线值")
            value = float(last)
        if not (DIST_MIN_VALID <= float(value) <= DIST_MAX_VALID):
            raise IngestError(f"基线 {value} mm 超出有效测距范围 "
                              f"[{DIST_MIN_VALID:.0f}, {DIST_MAX_VALID:.0f}]")
        row = db.get(DeviceBaseline, device_id)
        if row is None:
            row = DeviceBaseline(device_id=device_id, baseline_mm=float(value),
                                 source=source, note=note)
            db.add(row)
        else:
            row.baseline_mm = float(value)
            row.source = source
            row.note = note
            row.set_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        log.info("设备 %s 基线标定为 %.1f mm（%s）", device_id, float(value), source)
        return {"device_id": device_id, "baseline_mm": float(value), "source": source}
    finally:
        db.close()


def distance_to_displacement(db, device_id: str, channels: dict,
                             stats: dict) -> dict:
    """把原始测距换算成**累计位移**：`D = 基线 − DIST`。

    返回同一份 dict（就地补上 D、必要时清掉无效的 DIST）。设计取舍：
      * 无效测距（没打到目标/超量程）**只丢这一路**，不整条拒收 —— 否则一次遮挡
        会把同一报文里的温度、湿度、含水率一起丢掉（原型遮挡段实测掉到 36 mm、个位数）；
      * 第一次收到有效测距时自动记基线（之后跨重启都用它）；
      * 原始 DIST 原样保留，便于核对"位移是从哪来的"。
    """
    raw = channels.get("DIST")
    if raw is None:
        return channels
    if not (DIST_MIN_VALID <= float(raw) <= DIST_MAX_VALID):
        channels["DIST"] = None
        stats["distance_invalid"] = stats.get("distance_invalid", 0) + 1
        return channels
    row = db.get(DeviceBaseline, device_id)
    if row is None:
        row = DeviceBaseline(device_id=device_id, baseline_mm=float(raw), source="auto",
                             note="首次有效测距自动记录")
        db.add(row)
        db.flush()
        log.info("设备 %s 首次记录安装基线：%.1f mm（位移从 0 起算）", device_id, float(raw))
    channels["D"] = round(float(row.baseline_mm) - float(raw), 3)
    return channels


async def ingest_points(device_id: str, points: list[dict],
                        remote: str = "") -> dict:
    """硬件推送入口：幂等落库 → WebSocket 推送 → 触发一次推理与告警。

    幂等键是 `(device_id, ts)`：硬件断网后补传、或重发同一批，都不会写重。
    """
    if not points:
        raise IngestError("没有可写入的采样点")
    if len(points) > MAX_BATCH_POINTS:
        raise IngestError(f"单次最多 {MAX_BATCH_POINTS} 条，收到 {len(points)} 条")

    parsed: list[tuple[datetime, dict[str, float | None]]] = []
    for item in points:
        parsed.append((to_utc_naive(item["ts"]), normalize_channels(item["channels"])))
    parsed.sort(key=lambda pair: pair[0])

    inserted: list[tuple[datetime, dict[str, float | None]]] = []
    duplicated = 0
    stats: dict = {}                     # 本轮统计：无效测距条数等（要回给硬件侧看）
    db = SessionLocal()
    try:
        t_min, t_max = parsed[0][0], parsed[-1][0]
        existing = set(db.execute(
            select(SensorReading.ts).where(
                SensorReading.device_id == device_id,
                SensorReading.ts >= t_min,
                SensorReading.ts <= t_max,
            )
        ).scalars().all())
        for ts, channels in parsed:
            # 原始测距 → 累计位移（没有 DIST 的报文原样通过）
            channels = distance_to_displacement(db, device_id, channels, stats)
            if ts in existing:
                duplicated += 1
                continue
            existing.add(ts)
            db.add(SensorReading(device_id=device_id, ts=ts, source="hardware", **channels))
            inserted.append((ts, channels))
        db.commit()
    finally:
        db.close()

    for ts, channels in inserted:
        await broadcaster.publish({
            "type": "reading", "device_id": device_id,
            "ts": iso_utc(ts), "reading": channels,
        })
    if inserted:
        # 打上"这台已经是真实硬件"的持久标记：之后它的**这些通道**以实测为准，
        # 补齐序列不再生成同名通道。标记是持久的，重启进程/机器都不会回退。
        mark_hardware_device(device_id)
    log.info("硬件推送：设备 %s 写入 %d 条（重复跳过 %d 条）",
             device_id, len(inserted), duplicated)

    result: dict = {
        "accepted": len(inserted),
        "duplicated": duplicated,
        "latest_ts": iso_utc(parsed[-1][0]),
        "prediction_level": None,
    }
    if stats.get("distance_invalid"):
        # 如实回给硬件侧：这一轮有几条测距被判定为无效（没打到目标/超量程），
        # 它们只丢了测距这一路，其余通道照常入库。
        result["distance_invalid"] = stats["distance_invalid"]
    # 接入审计：每次上报记一条元信息（条数 / 去重数 / 来源 IP）。
    # 通信侧的问题——"谁什么时候推的、断没断、换没换网、补传了多少"——
    # 只能从这张表回答，sensor_readings 里看不出来。
    db = SessionLocal()
    try:
        db.add(IngestEvent(device_id=device_id, accepted=len(inserted),
                           duplicated=duplicated, remote=remote[:64]))
        db.commit()
    finally:
        db.close()
    if inserted:                                  # 只在真有新数据时才跑推理
        prediction = evaluate_device(device_id)
        if prediction:
            result["prediction_level"] = prediction.get("combined_level")
            await broadcaster.publish(prediction_event(device_id, prediction))
    return result


def prediction_event(device_id: str, result: dict) -> dict:
    """把一次推理结果整理成推送事件（字段与大屏直接对应）。"""
    return {
        "type": "prediction", "device_id": device_id, "ts": result.get("ts"),
        "mode": result.get("mode"),
        "sentinel_level": result.get("sentinel_level"),
        "forecast_level": result.get("forecast_level"),
        "combined_level": result.get("combined_level"),
        "stage": result.get("stage"), "advice": result.get("advice"),
        "p7": result.get("p7"), "p30": result.get("p30"),
        "notes": result.get("notes", []),
        "alert_action": result.get("alert_action"),
        "alert_id": result.get("alert_id"),
    }


async def poll_once(device_id: str, skip_channels: set[str] | None = None) -> dict[str, float]:
    """拉取一台设备的最新读数并落库，返回通道字典。

    这些值是**补齐序列**，一律以 `source='simulation'` 落库。
    `skip_channels` 里是硬件已经负责的通道，不生成、不落库——补齐绝不覆盖实测。
    """
    if settings.tuya_configured:
        try:
            channels = await client.fetch_channels(device_id)
        except TuyaError as exc:
            log.warning("设备 %s 读取失败：%s", device_id, exc)
            return {}
    else:
        # 无凭证：用与库中最近读数连续的虚拟设备（不是"每次各自随机"）
        channels = virtual_device.advance(device_id)
    if skip_channels:
        channels = {k: v for k, v in channels.items() if k not in skip_channels}
    if not channels:
        log.warning("设备 %s 未返回任何已知通道", device_id)
        return {}
    row = save_reading(device_id, channels, source="simulation")
    log.info("设备 %s 补齐序列已落库（source=simulation）：%s", device_id, channels)
    await broadcaster.publish({
        "type": "reading", "device_id": device_id,
        "ts": iso_utc(row.ts), "reading": channels,
    })
    return channels


_DAILY_SQL = text("""
    WITH per_day AS (
        SELECT ts, D, RN, RNM,
               -- 别名不能叫 rn：SQLite 标识符不分大小写，会和雨量列 RN 撞名，
               -- 于是 WHERE 里筛的是雨量而不是行号（实测返回 0 行）。
               -- 排序先按"位移是否为空"：（D IS NULL）在 SQLite 里是 0/1，
               -- 升序即"有值在前"。硬件只报温湿度的日子里，当日最后一行往往是
               -- 空的硬件行，直接取最后一行会把当天位移读成 NULL、整段日尺度退化。
               ROW_NUMBER() OVER (PARTITION BY date(ts)
                                  ORDER BY (D IS NULL), ts DESC) AS row_rank
        FROM sensor_readings
        WHERE device_id = :dev AND ts >= :since
    ),
    rain AS (
        -- 降雨特征只认 RNM（mm）。RN 是"雨量感应强度 %"，累加百分比没有物理意义。
        SELECT date(ts) AS d, SUM(COALESCE(RNM, 0.0)) AS rain_sum
        FROM sensor_readings
        WHERE device_id = :dev AND ts >= :since
        GROUP BY date(ts)
    )
    SELECT p.ts AS ts, p.D AS disp, COALESCE(r.rain_sum, 0.0) AS rain
    FROM per_day p
    LEFT JOIN rain r ON r.d = date(p.ts)
    WHERE p.row_rank = 1
    ORDER BY p.ts
""")


def load_series(device_id: str, days: int = 400, max_rows: int | None = None) -> pd.DataFrame | None:
    """读某设备最近 N 天的读数，**在 SQL 侧**按自然日聚合（线上推理的唯一入口）。

    口径与算法侧对齐：位移取当日最后一条（累计量）、雨量取当日累加，不补齐缺失日期。

    若该设备关联了库水位站，会一并对齐出 `level` 列，推理自动进入 `full`（双时间尺度）模式；
    库水位没有数据时保持缺失，推理自动退回 `sentinel_only`，绝不凭空补水位。

    **为什么在 SQL 侧聚合**（2026-09-16 修正）：旧实现是"先取最多 `max_rows` 行、
    再在 pandas 里按日聚合"。读取行数随采样率线性增长，1 分钟采样时 20000 行只够约 14 天，
    于是 `days=400` 的请求会被**静默截断成 14 天**（日尺度历史与 μ/σ 参考段一起变短）。
    现在聚合在库里完成，返回行数最多就是天数，不再有截断风险。
    `max_rows` 保留在签名里只为兼容旧调用方，已不再使用。
    """
    db = SessionLocal()
    try:
        since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
        # 走原生 SQL 时必须传字符串：绑定裸 datetime 时 SQLAlchemy 拿不到列类型，
        # 比较会静默失败（实测返回 0 行）。库里 ts 是 TEXT（'YYYY-MM-DD HH:MM:SS.ffffff'），
        # 这个格式的字典序与时间序一致，字符串比较是安全的。
        rows = db.execute(_DAILY_SQL,
                          {"dev": device_id,
                           "since": since.strftime("%Y-%m-%d %H:%M:%S")}).fetchall()
        if not rows:
            return None
        daily = pd.DataFrame(
            {"ts": [r[0] for r in rows], "disp": [r[1] for r in rows],
             "rain": [r[2] for r in rows]}
        )
    finally:
        db.close()
    dev = manager.get(device_id)
    if dev is not None and dev.station_id:
        daily = attach_level(daily, dev.station_id)
        if "level" not in daily.columns or daily["level"].isna().all():
            log.warning("设备 %s 关联的水位站 %s 没有可用数据，本次按哨兵模式推理",
                        device_id, dev.station_id)
    return daily


def load_raw_series(device_id: str, days: int = SENTINEL_RAW_DAYS,
                    max_rows: int = 200000) -> pd.DataFrame | None:
    """读原始读数（**不聚合**）。

    哨兵层要用它算滚动窗口增量：日聚合帧在跨自然日时"当天"只有几分钟数据，
    日增量会被系统性低估（实测每天北京 08:00 等级归零一次）。

    **只取位移有值的行**：哨兵层吃的就是位移增量，硬件推上来的温湿度行位移为空，
    混进来只会让窗口里一半是 NaN。过滤后剩下的就是一条干净的位移观测序列。
    """
    db = SessionLocal()
    try:
        since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
        rows = db.execute(
            select(SensorReading)
            .where(SensorReading.device_id == device_id, SensorReading.ts >= since,
                   SensorReading.D.isnot(None))
            .order_by(SensorReading.ts.desc()).limit(max_rows)
        ).scalars().all()
        if not rows:
            return None
        if len(rows) == max_rows:
            log.warning("设备 %s 读数超过 %d 条上限，仅使用最近部分", device_id, max_rows)
        return pd.DataFrame({
            "ts": [r.ts for r in reversed(rows)],
            "disp": [r.D for r in reversed(rows)],
            # 降雨特征只认 RNM（mm）；RN 是感应强度百分比，不能当雨量累加
            "rain": [r.RNM for r in reversed(rows)],
        })
    finally:
        db.close()


async def poll_all() -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for dev in manager.all():
        # 2026-09-22 修正：接入硬件后**不再整台跳过**，而是"实测优先 + 缺的通道补齐"。
        # 旧写法是 `if is_hardware_device(...): continue` —— 后果是硬件一上线，
        # 这台设备的其余通道（位移/倾角/雨量/含水率）立刻断供、曲线断崖、哨兵层退化。
        # 现在按通道分工：硬件推过的通道交给硬件，剩下的由同口径序列继续补，
        # 两者写入的 source 不同，永远分得清谁是谁。
        provided = hardware_channels(dev.device_id)
        if len(provided) >= len(ALLOWED_CHANNELS):
            continue                       # 硬件已全通道覆盖，没有可补的
        out[dev.device_id] = await poll_once(dev.device_id, skip_channels=provided)
    return out


async def polling_loop(stop: asyncio.Event) -> None:
    """后台定时任务；由 main.py 的 lifespan 启动。"""
    interval = max(10, settings.tuya_poll_seconds)
    log.info("设备轮询已启动，间隔 %s 秒（涂鸦凭证：%s）",
             interval, "已配置" if settings.tuya_configured else "未配置，使用模拟数据")
    while not stop.is_set():
        try:
            await poll_all()
            for dev in manager.all():
                result = evaluate_device(dev.device_id)
                if result:
                    await broadcaster.publish(prediction_event(dev.device_id, result))
            # 涌浪推演也走同一轮：它吃的是实时输入（库水位、监测速率），
            # 所以必须每轮重算，等级才能成为一条连续的流进告警台账。
            if settings.wave_bindings:
                from services.wave_watch import evaluate_all_sites
                evaluate_all_sites(settings.wave_bindings)
        except Exception as exc:                      # noqa: BLE001 - 轮询不能因单次异常退出
            log.exception("轮询失败：%s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
    log.info("设备轮询已停止")


def evaluate_device(device_id: str, days: int = 200) -> dict | None:
    """读最近读数 -> 推理 -> 落库 Prediction -> 驱动告警引擎。返回最新一条结果。"""
    db = SessionLocal()
    try:
        df = load_series(device_id, days=days)
        if df is None or len(df) < 30:
            log.info("设备 %s 日尺度数据不足（%s 天），暂不推理",
                     device_id, 0 if df is None else len(df))
            return None
        # 原始读数单独取一份短历史：哨兵层的滚动窗口增量必须用**未聚合**的读数
        raw = load_raw_series(device_id, days=SENTINEL_RAW_DAYS)
        series = predictor.predict_series(df, raw_df=raw)
        last = series[-1]

        now = datetime.now(timezone.utc)
        prev = db.execute(
            select(Prediction).where(Prediction.device_id == device_id)
            .order_by(Prediction.ts.desc()).limit(1)
        ).scalars().first()
        # 只有"等级相同 + 输出形态相同"才算重复：
        # 一旦从哨兵模式切到融合模式（开始有 p7/p30），必须立刻落一条新记录，
        # 否则大屏会在节流窗口内拿着"没有概率值"的旧记录当当前状态。
        # "输出形态相同"除了概率列，还要看**可用性**：从"有数据"变成"没数据"必须立刻落一条，
        # 否则大屏会在节流窗口里继续显示上一次的等级，看不出数据已经断了。
        data_ok = bool(last.get("data_available", True))
        same_shape = (prev is not None
                      and ((prev.p30 is None) == (last["p30"] is None))
                      and (bool(getattr(prev, "data_available", True)) == data_ok))
        if (prev is not None and prev.ts is not None and same_shape
                and prev.combined_level == last["combined_level"]):
            age = (now.replace(tzinfo=None) - prev.ts).total_seconds()
            if age < PREDICTION_MIN_INTERVAL_SECONDS:
                return {**last, "alert_action": "throttled", "alert_id": None}

        db.add(Prediction(
            device_id=device_id, ts=now,
            p7=last["p7"], p30=last["p30"],
            sentinel_level=last["sentinel_level"],
            sentinel_channels=",".join(last["sentinel_channels"]),
            forecast_level=(last["forecast_level"] or 0),
            combined_level=last["combined_level"], stage=last["stage"],
            data_available=data_ok,
        ))
        db.commit()

        if not data_ok:
            # 数据不足时**不驱动告警引擎**：既不能据此新建告警，也不能据此解除、
            # 降级既有告警 —— 我们只是"不知道"，而"不知道"不是"没事"。
            prev_open = db.execute(
                select(func.count()).select_from(Alert)
                .where(Alert.device_id == device_id, Alert.status.in_(("open", "acked")))
            ).scalar_one()
            log.info("设备 %s 近 24h 无可用位移增量，跳过告警判定（未处理告警保持 %d 条）",
                     device_id, prev_open)
            return {**last, "alert_action": "no_data", "alert_id": None}

        decision = alert_engine.process(
            db, device_id, last["combined_level"], last["stage"],
            reason=alert_reason(last))
        return {**last, "alert_action": decision.action, "alert_id": decision.alert_id}
    finally:
        db.close()
