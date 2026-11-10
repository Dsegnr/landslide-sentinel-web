"""天气接入：只做「预警权重参比」，不参与是否报警的判定。

三条硬规矩（都是踩过外网接口的坑总结的）：

1. **不挡主链路**：任何情况下天气接口失败都不能让预警接口跟着失败——
   拉不到就返回上一次的缓存并标 `stale=true`，没缓存就返回 `available=false`；
2. **必须缓存**：结果落 `weather_cache` 表，缓存窗口内不重复打外网（默认 30 分钟）；
3. **来源可换**：默认用 Open-Meteo（免密钥、含逐小时降水预报），
   配了和风 key + host 就切 `qweather`，接口形状对上层保持一致。

为什么不用爬虫：站点结构一变就挂、有反爬与条款风险，而我们的需求量（两个点位、
半小时一次）用公开 API 的免费额度绰绰有余。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select

from config import settings
from database import SessionLocal, WeatherCache

log = logging.getLogger("sentinel.weather")

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 12.0


def _round_key(lon: float, lat: float) -> str:
    # 带版本前缀：以后响应结构变了，旧缓存自然失效，不会出现"半新半旧"的字段
    return f"v2:{round(lon, 2):.2f},{round(lat, 2):.2f}"


def weight_bonus(rain24h: float, rain72h: float) -> tuple[float, str]:
    """把未来降雨折算成"关注权重"增量（0~0.5）。

    两层：**近期雨强**看 24 小时累计，**持续降雨**看 72 小时累计——
    库区/黄土坡体的失稳常常是"连着下了几天"，只看 24 小时会漏掉这种过程雨。
    阈值是工程口径：宁可保守，不要因为一场小雨把等级顶上去。
    """
    if rain24h >= 50:
        base, why = 0.40, f"未来 24 小时累计降雨 {rain24h:.1f} mm（强降雨）"
    elif rain24h >= 25:
        base, why = 0.30, f"未来 24 小时累计降雨 {rain24h:.1f} mm（大雨）"
    elif rain24h >= 10:
        base, why = 0.20, f"未来 24 小时累计降雨 {rain24h:.1f} mm（中雨）"
    elif rain24h >= 3:
        base, why = 0.10, f"未来 24 小时累计降雨 {rain24h:.1f} mm（小到中雨）"
    else:
        base, why = 0.0, f"未来 24 小时累计降雨 {rain24h:.1f} mm（未到加权阈值）"
    if rain72h >= 150:
        base = min(0.5, base + 0.15)
        why += f"；未来 72 小时累计 {rain72h:.1f} mm（持续强降雨），叠加 +0.15"
    elif rain72h >= 80:
        base = min(0.5, base + 0.10)
        why += f"；未来 72 小时累计 {rain72h:.1f} mm（持续降雨），叠加 +0.10"
    elif rain72h >= 20:
        base = min(0.5, base + 0.05)
        why += f"；未来 72 小时累计 {rain72h:.1f} mm（过程雨），叠加 +0.05"
    return round(base, 2), why


# WMO 天气码 → 中文现象（Open-Meteo 用这套编码）
WMO_TEXT: dict[int, str] = {
    0: '晴', 1: '基本晴', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻毛毛雨', 57: '冻雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '中阵雨', 82: '强阵雨',
    85: '小阵雪', 86: '大阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
}

# 严重度 → 颜色 / 文案（前端图标与地图配色都用这套）
SEVERITY_COLOR = {0: '#7fd4ff', 1: '#4fc3f7', 2: '#ffd166', 3: '#ff8a4c', 4: '#ff4d6d'}
SEVERITY_LABEL = {0: '无降水', 1: '小', 2: '中', 3: '大', 4: '特大'}
SEVERITY_RISK = {
    0: '无降水，坡体暂无降雨触发',
    1: '有降水，注意坡面渗流与裂缝变化',
    2: '中等降雨：孔隙水压上升，位移可能加速',
    3: '大雨：滑坡触发概率明显上升',
    4: '强降水/雷暴：短时强降雨是滑坡高发的触发条件',
}


def classify_weather(code: int | None, now_precip: float, rain24h: float) -> dict:
    """天气现象 → 严重度（0~4）与颜色。

    判据只用对滑坡有意义的量：**当前雨强 + 未来 24 小时累计**，雷暴直接顶到最高档
    （短时强降水是滑坡最常见的直接触发）。晴/多云这类记 0 档，不参与加权。
    """
    code = int(code or 0)
    if code >= 95:
        sev = 4
    elif now_precip >= 8 or rain24h >= 50:
        sev = 4
    elif now_precip >= 3 or rain24h >= 25:
        sev = 3
    elif now_precip >= 0.6 or rain24h >= 10:
        sev = 2
    elif now_precip > 0 or rain24h >= 3:
        sev = 1
    else:
        sev = 0
    return {
        "code": code,
        "phenomenon": WMO_TEXT.get(code, f'未知({code})'),
        "severity": sev,
        "severity_label": SEVERITY_LABEL[sev],
        "severity_color": SEVERITY_COLOR[sev],
        "risk_note": SEVERITY_RISK[sev],
    }


def normalize_open_meteo(raw: dict, lon: float, lat: float) -> dict:
    """Open-Meteo 响应 → 我们的统一结构。"""
    hourly = raw.get("hourly") or {}
    times: list[str] = hourly.get("time") or []
    precip: list[float | None] = hourly.get("precipitation") or []
    temps: list[float | None] = hourly.get("temperature_2m") or []
    pops: list[float | None] = hourly.get("precipitation_probability") or []
    cur = raw.get("current") or {}

    rows = []
    for i, t in enumerate(times):
        rows.append({
            "t": t,
            "precip": float(precip[i] or 0.0) if i < len(precip) else 0.0,
            "temp": float(temps[i]) if i < len(temps) and temps[i] is not None else None,
        })
    n24 = rows[:24]
    n72 = rows[:72]
    rain24 = sum(r["precip"] for r in n24)
    rain72 = sum(r["precip"] for r in n72)
    bonus, why = weight_bonus(rain24, rain72)
    now_temp = next((r["temp"] for r in rows if r["temp"] is not None), None)
    now_precip = float(cur.get("precipitation") or 0.0)
    code = cur.get("weather_code")
    cls = classify_weather(code, now_precip, rain24)
    return {
        "available": True,
        "source": "open-meteo",
        "lon": lon,
        "lat": lat,
        "now": {
            "temp": float(cur.get("temperature_2m")) if cur.get("temperature_2m") is not None else now_temp,
            "precip": now_precip,
            "humidity": cur.get("relative_humidity_2m"),
            "wind": cur.get("wind_speed_10m"),
            "pop": (pops[0] if pops else None),
            "text": cls["phenomenon"],
        },
        "hourly": rows[:24],
        "rain24h": round(rain24, 1),
        "rain72h": round(rain72, 1),
        "max_hourly": round(max((r["precip"] for r in n72), default=0.0), 1),
        "weight_bonus": bonus,
        "weight_reason": why,
        **cls,
    }


async def fetch_open_meteo(lon: float, lat: float) -> dict:
    params = {
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "current": "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        "hourly": "precipitation,temperature_2m",
        "forecast_days": "4",
        "timezone": "Asia/Shanghai",
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(OPEN_METEO, params=params)
        resp.raise_for_status()
        return normalize_open_meteo(resp.json(), lon, lat)


async def fetch_qweather(lon: float, lat: float) -> dict:
    """和风天气（需要 QWEATHER_KEY + QWEATHER_HOST，未配置时抛错由上层降级）。"""
    if not (settings.qweather_key and settings.qweather_host):
        raise RuntimeError("未配置和风天气 key/host")
    headers = {"X-QW-Api-Key": settings.qweather_key}
    base = f"https://{settings.qweather_host}"
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=headers) as client:
        r24 = await client.get(f"{base}/v7/weather/24h",
                               params={"location": f"{lon:.2f},{lat:.2f}"})
        r24.raise_for_status()
        data = r24.json()
    hourly_raw = (data.get("hourly") or [])
    rows = [{"t": h.get("fxTime"), "precip": float(h.get("precip") or 0),
             "temp": float(h["temp"]) if h.get("temp") is not None else None}
            for h in hourly_raw]
    rain24 = sum(r["precip"] for r in rows[:24])
    rain72 = rain24
    bonus, why = weight_bonus(rain24, rain72)
    return {
        "available": True, "source": "qweather", "lon": lon, "lat": lat,
        "now": {"temp": rows[0]["temp"] if rows else None,
                "precip": rows[0]["precip"] if rows else 0.0, "text": None},
        "hourly": rows[:24],
        "rain24h": round(rain24, 1), "rain72h": round(rain72, 1),
        "max_hourly": round(max((r["precip"] for r in rows[:24]), default=0.0), 1),
        "weight_bonus": bonus, "weight_reason": why,
    }


# 全国网格：2°×2°，覆盖中国主体（图上一格 ≈ 200 km）。
# 2° 是为了让降水点相互重叠、连成"色块"——4° 时点之间会露白，看着像气泡而不是雨区。
GRID_LON = list(range(74, 136, 2))
GRID_LAT = list(range(18, 56, 2))
GRID_KEY = "grid:v2"


async def fetch_grid() -> dict:
    """取全国粗网格的**实时降水**，给地图铺一层"降水色块"。

    为什么走得通：Open-Meteo 支持一次请求多个经纬度（逗号分隔），
    135 个点一次请求约 50 KB、1 秒左右，10 分钟刷一次完全够。
    """
    lats: list[float] = []
    lons: list[float] = []
    for lat in GRID_LAT:
        for lon in GRID_LON:
            lats.append(float(lat))
            lons.append(float(lon))
    params = {
        "latitude": ",".join(f"{v:.0f}" for v in lats),
        "longitude": ",".join(f"{v:.0f}" for v in lons),
        "current": "precipitation,weather_code",
        "timezone": "Asia/Shanghai",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(OPEN_METEO, params=params)
        resp.raise_for_status()
        raw = resp.json()
    items = raw if isinstance(raw, list) else [raw]
    points = []
    wet = 0
    for p in items:
        cur = p.get("current") or {}
        precip = float(cur.get("precipitation") or 0.0)
        code = int(cur.get("weather_code") or 0)
        cls = classify_weather(code, precip, 0.0)
        if precip > 0:
            wet += 1
        points.append({
            "lon": round(float(p.get("longitude", 0.0)), 3),
            "lat": round(float(p.get("latitude", 0.0)), 3),
            "precip": round(precip, 2),
            "code": code,
            "severity": cls["severity"],
            "phenomenon": cls["phenomenon"],
        })
    return {
        "available": True,
        "source": "open-meteo",
        "kind": "grid",
        "count": len(points),
        "wet": wet,
        "points": points,
    }


async def get_weather_grid(*, force: bool = False) -> dict:
    """带缓存的全国降水网格（失败同样降级，不影响预警）。"""
    if not settings.weather_enabled:
        return {"available": False, "source": "none", "points": [], "error": "天气功能已关闭"}
    row = _load_cache(GRID_KEY)
    ttl = timedelta(minutes=settings.weather_cache_minutes)
    now = datetime.now(timezone.utc)
    if row is not None and not force:
        age = now - (row.fetched_at.replace(tzinfo=timezone.utc)
                     if row.fetched_at.tzinfo is None else row.fetched_at)
        if age < ttl:
            data = json.loads(row.payload)
            data["stale"] = False
            data["cached"] = True
            return data
    try:
        data = await fetch_grid()
        data["fetched_at"] = now.isoformat()
        data["stale"] = False
        data["cached"] = False
        _save_cache(GRID_KEY, data)
        return data
    except Exception as exc:                      # noqa: BLE001
        log.warning("降水网格拉取失败：%s", exc)
        if row is not None:
            data = json.loads(row.payload)
            data["stale"] = True
            data["error"] = f"{type(exc).__name__}: {exc}"
            return data
        return {"available": False, "source": "none", "points": [],
                "error": f"{type(exc).__name__}: {exc}"}


def _load_cache(key: str):
    db = SessionLocal()
    try:
        return db.execute(
            select(WeatherCache).where(WeatherCache.cache_key == key)
        ).scalars().first()
    finally:
        db.close()


def _save_cache(key: str, payload: dict) -> None:
    db = SessionLocal()
    try:
        row = db.execute(
            select(WeatherCache).where(WeatherCache.cache_key == key)
        ).scalars().first()
        text = json.dumps(payload, ensure_ascii=False)
        if row is None:
            db.add(WeatherCache(cache_key=key, payload=text))
        else:
            row.payload = text
            row.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    finally:
        db.close()


def _unavailable(reason: str) -> dict:
    return {"available": False, "source": "none", "stale": True, "error": reason,
            "weight_bonus": 0.0, "weight_reason": "无天气数据"}


async def get_weather(lon: float, lat: float, *, force: bool = False) -> dict:
    """取天气（带缓存与降级）。**任何异常都不会往上抛**。"""
    if not settings.weather_enabled:
        return _unavailable("天气功能已关闭")

    key = _round_key(lon, lat)
    row = _load_cache(key)
    ttl = timedelta(minutes=settings.weather_cache_minutes)
    now = datetime.now(timezone.utc)
    if row is not None and not force:
        age = now - (row.fetched_at.replace(tzinfo=timezone.utc)
                     if row.fetched_at.tzinfo is None else row.fetched_at)
        if age < ttl:
            data = json.loads(row.payload)
            data["stale"] = False
            data["cached"] = True
            return data

    fetcher = fetch_qweather if settings.weather_provider == "qweather" else fetch_open_meteo
    try:
        data = await fetcher(lon, lat)
        data["fetched_at"] = now.isoformat()
        data["stale"] = False
        data["cached"] = False
        _save_cache(key, data)
        return data
    except Exception as exc:                      # noqa: BLE001 - 外网接口一律降级
        log.warning("天气拉取失败（%s）：%s", settings.weather_provider, exc)
        if row is not None:
            data = json.loads(row.payload)
            data["stale"] = True
            data["cached"] = True
            data["error"] = f"{type(exc).__name__}: {exc}"
            data["weight_reason"] = (data.get("weight_reason", "")
                                     + "（天气接口暂不可用，用上一次结果）")
            return data
        return _unavailable(f"{type(exc).__name__}: {exc}")
