"""天气接口：给大屏与三维页提供「未来降雨 → 关注权重」参比。

注意：这里返回的只是**参比信息**，不参与是否报警的判定；
接口取不到数据时返回 available=false，前端如实显示"无天气数据"即可。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query

from services.auth import Principal, current_principal
from services.weather import get_weather, get_weather_grid

router = APIRouter(prefix="/api", tags=["weather"])

# 一次最多多少个点位。大屏/现场页现在各 20+ 个点，40 留一倍余量；
# 再大就是被当批量抓取接口用了，直接拒掉。
MAX_BATCH_POINTS = 40
# 并发上限：点位第一次访问时缓存是空的，会同时打外网。6 路既能把首轮
# 等待压到"一个外网往返"，又不会把 Open-Meteo 打限流。
BATCH_CONCURRENCY = 6


def _parse_points(raw: str) -> list[tuple[float, float]]:
    """解析 `lon,lat;lon,lat`。格式错就直接 400，不做"猜他想传什么"。"""
    pairs: list[tuple[float, float]] = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split(",")
        if len(parts) != 2:
            raise HTTPException(status_code=400, detail=f"点位格式应为 lon,lat：{chunk!r}")
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"点位不是数字：{chunk!r}") from exc
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise HTTPException(status_code=400, detail=f"经纬度超范围：{chunk!r}")
        pairs.append((lon, lat))
    if not pairs:
        raise HTTPException(status_code=400, detail="points 为空")
    if len(pairs) > MAX_BATCH_POINTS:
        raise HTTPException(status_code=400,
                            detail=f"一次最多 {MAX_BATCH_POINTS} 个点位（收到 {len(pairs)} 个）")
    return pairs


@router.get("/weather")
async def weather(lon: float = Query(..., ge=-180, le=180),
                  lat: float = Query(..., ge=-90, le=90),
                  force: bool = False,
                  principal: Principal = Depends(current_principal)) -> dict:
    """按经纬度取天气（带缓存与降级；force=true 强制刷新）。"""
    return await get_weather(lon, lat, force=force)


@router.get("/weather/batch")
async def weather_batch(points: str = Query(..., description="lon,lat;lon,lat;…"),
                        force: bool = False,
                        principal: Principal = Depends(current_principal)) -> dict:
    """一次取多个点位的天气。

    为什么要有这个接口：大屏与现场页要在地图上给 20+ 个点位挂天气图标，
    原先每个点位单独请求一次 `/api/weather`。走公网时每个请求有近 1 秒的固定
    往返（隧道），24 个点就是三四秒——页面"进去好卡"主要就是它。

    语义与单点接口**完全一致**：同一个 `get_weather`、同一套缓存与降级、
    返回结构与字段一模一样，只是合成一批。`items` 与输入点位一一对应、保持原顺序。
    """
    parsed = _parse_points(points)

    # 同一坐标只取一次（大屏上"站点"与"设备"可能落在同一格），
    # 但返回时仍按输入顺序给出等长的 items，调用方按下标对齐即可。
    unique: dict[str, tuple[float, float]] = {}
    keys: list[str] = []
    for lon, lat in parsed:
        key = f"{round(lon, 2):.2f},{round(lat, 2):.2f}"
        keys.append(key)
        unique.setdefault(key, (lon, lat))

    sem = asyncio.Semaphore(BATCH_CONCURRENCY)

    async def one(lon: float, lat: float) -> dict:
        async with sem:
            return await get_weather(lon, lat, force=force)

    fetched = await asyncio.gather(*(one(lo, la) for lo, la in unique.values()))
    by_key = dict(zip(unique.keys(), fetched))
    items = [{"lon": lon, "lat": lat, "weather": by_key[key]}
             for (lon, lat), key in zip(parsed, keys)]
    return {"count": len(items), "items": items}


@router.get("/weather/grid")
async def weather_grid(force: bool = False,
                       principal: Principal = Depends(current_principal)) -> dict:
    """全国粗网格实时降水（地图上的降水色块，10 分钟缓存）。"""
    return await get_weather_grid(force=force)
