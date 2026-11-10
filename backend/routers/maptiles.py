"""地图瓦片代理：专业底图（OpenFreeMap 矢量）与雷达降水（RainViewer）。

为什么要代理：**演示机的浏览器往往连不上境外服务**（实测：同一台机器上
浏览器请求 openfreemap/rainviewer 全部 Failed to fetch，而服务器 curl 全部 200）。
瓦片经我们的后端转发，浏览器只跟本机/本服务打交道，就稳了；
顺带把瓦片落盘缓存，重复浏览不再打外网。

安全：**只放行白名单主机与前缀**，不做通用代理（避免被当成开放代理/SSRF）；
单文件限 4 MB、20 秒超时、失败即返回 502，绝不把异常抛给前端。
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import asyncio
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from urllib.parse import urlparse

from config import settings

log = logging.getLogger("sentinel.maptiles")
router = APIRouter(prefix="/api/map", tags=["maptiles"])

OPENFREEMAP = "https://tiles.openfreemap.org"
RAINVIEWER_TILES = "https://tilecache.rainviewer.com"
RAINVIEWER_API = "https://api.rainviewer.com"

# 高德栅格瓦片（演示用底图）：
#   vec = 矢量路网+注记（浅色，最接近手机天气 App 的底图观感）
#   img = 卫星影像
# 注意：这是直接取瓦片，未走高德官方 JS API（比赛演示常见做法，合规性见文档说明）。
AMAP_HOSTS = {
    "vec": "https://webrd0{1-4}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8",
    "img": "https://webst0{1-4}.is.autonavi.com/appmaptile?style=6",
}

# 允许转发的路径前缀（收紧到具体目录，别的路径一律 404）
ALLOWED_PREFIX = {
    OPENFREEMAP: ("planet/", "fonts/", "sprites/", "styles/", "tiles/", "natural_earth/"),
    RAINVIEWER_TILES: ("v2/radar/",),
    RAINVIEWER_API: ("public/weather-maps.json",),
}

# 允许被代理的**主机后缀**（跳转校验也用它，防上游 302 到内网 → SSRF）
ALLOWED_HOST_SUFFIXES = (
    "tiles.openfreemap.org",
    "tilecache.rainviewer.com",
    "api.rainviewer.com",
    "is.autonavi.com",          # 高德栅格瓦片（webst01 / webrd01 等子域）
)

_CACHE_DIR = Path(settings.tile_cache_dir)
_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _cache_path(key: str) -> Path:
    return _CACHE_DIR / key[:2] / key


def _read_cache(key: str, ttl_seconds: int | None = None) -> tuple[bytes, str] | None:
    path = _cache_path(key)
    meta = path.with_suffix(".meta")
    if not path.is_file() or not meta.is_file():
        return None
    if ttl_seconds is not None:
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
            if time.time() - float(info.get("t", 0)) > ttl_seconds:
                return None
        except Exception:                      # noqa: BLE001
            return None
    try:
        info = json.loads(meta.read_text(encoding="utf-8"))
        return path.read_bytes(), info.get("ct", "application/octet-stream")
    except Exception:                          # noqa: BLE001
        return None


def _write_cache(key: str, body: bytes, content_type: str) -> None:
    try:
        path = _cache_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.with_suffix(".meta").write_text(
            json.dumps({"t": time.time(), "ct": content_type}), encoding="utf-8")
    except Exception as exc:                   # noqa: BLE001
        log.warning("瓦片缓存写入失败：%s", exc)


def _allowed(base: str, path: str) -> bool:
    allowed = ALLOWED_PREFIX.get(base)
    if allowed is None:
        return False
    # 规范化拒绝：带 ..（含 URL 编码后被解码出来的）一律挡掉，
    # 免得"看起来像白名单前缀、实际是指向别处的相对路径"
    if ".." in path or "\\" in path:
        return False
    # 既放行精确端点（如 planet 的 TileJSON），也放行其子路径
    return any(path == p.rstrip("/") or path.startswith(p) for p in allowed)


def _host_allowed(url: str) -> bool:
    """校验最终 URL 的主机在白名单内。

    为什么需要：代理开了 follow_redirects，万一上游 302 到内网地址，
    就变成了对内网的 SSRF。这里对**跳转后的最终 URL** 再做一次主机校验。
    """
    host = (urlparse(url).hostname or "").lower()
    return any(host == s or host.endswith("." + s) for s in ALLOWED_HOST_SUFFIXES)


async def _proxy(base: str, path: str, ttl_seconds: int | None,
                 rewrite_prefix: str | None = None) -> Response:
    if not _allowed(base, path):
        raise HTTPException(status_code=404, detail="不允许的瓦片路径")
    url = f"{base}/{path}"
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    cached = _read_cache(key, ttl_seconds)
    if cached is None:
        try:
            # 上游偶发 429/5xx（尤其快速缩放时）重试一次，避免把瞬时失败当成"底图挂了"
            resp = None
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                for attempt in range(2):
                    resp = await client.get(url, headers={"User-Agent": "slope-sentinel/1.0"})
                    if resp.status_code < 400:
                        break
                    # 只对"上游限流/服务端错误"重试；404 这类确定性失败不重试
                    if attempt == 0 and (resp.status_code == 429 or resp.status_code >= 500):
                        await asyncio.sleep(0.6)
                    else:
                        break
            assert resp is not None
            # 跳转后的最终地址也必须落在白名单内（防上游 302 到内网 → SSRF）
            if not _host_allowed(str(resp.url)):
                raise HTTPException(status_code=502, detail="上游跳转到了未授权主机")
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"上游返回 {resp.status_code}")
            body = resp.content
            if len(body) > settings.tile_max_bytes:
                raise HTTPException(status_code=502, detail="瓦片过大，已拒绝")
            cached = (body, resp.headers.get("content-type", "application/octet-stream"))
            _write_cache(key, cached[0], cached[1])
        except HTTPException:
            raise
        except Exception as exc:               # noqa: BLE001
            log.warning("瓦片拉取失败 %s：%s", url, exc)
            raise HTTPException(status_code=502, detail=f"瓦片拉取失败：{exc}")
    body, ct = cached
    # TileJSON 之类的 JSON 响应里还带着上游主机名，也要改写成走本代理
    if rewrite_prefix and "json" in ct:
        try:
            text = body.decode("utf-8").replace(base, rewrite_prefix)
            body = text.encode("utf-8")
        except Exception as exc:               # noqa: BLE001
            log.warning("JSON 改写失败：%s", exc)
    return Response(content=body, media_type=ct,
                    headers={"Cache-Control": "public, max-age=86400"})


def _proxy_prefix(request: Request, slug: str) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.netloc)
    return f"{proto}://{host}/api/map/{slug}"


@router.get("/style")
async def style(request: Request, name: str = "positron") -> Response:
    """取矢量底图样式（把里面的外链改成走本代理）。"""
    if name not in {"positron", "dark", "liberty", "bright"}:
        raise HTTPException(status_code=400, detail="未知样式")
    resp = await _proxy(OPENFREEMAP, f"styles/{name}", ttl_seconds=6 * 3600)
    text = resp.body.decode("utf-8")
    # 必须替换成**绝对地址**：MapLibre 对 sprite 明确要求绝对 URL
    # （用请求自带的 host/scheme，隧道访问时也能拼出正确域名）
    prefix = _proxy_prefix(request, "openfreemap")
    text = text.replace(OPENFREEMAP, prefix)
    return Response(content=text, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/openfreemap/{path:path}")
async def openfreemap(request: Request, path: str) -> Response:
    """矢量瓦片 / 字体 / 精灵图代理。"""
    return await _proxy(OPENFREEMAP, path, ttl_seconds=7 * 86400,
                        rewrite_prefix=_proxy_prefix(request, "openfreemap"))


@router.get("/radar-meta")
async def radar_meta() -> Response:
    """RainViewer 雷达帧列表（含过去 2 小时各帧地址），缓存 5 分钟。"""
    return await _proxy(RAINVIEWER_API, "public/weather-maps.json", ttl_seconds=300)


@router.get("/radar/{path:path}")
async def radar(path: str) -> Response:
    """雷达降水瓦片代理。"""
    return await _proxy(RAINVIEWER_TILES, path, ttl_seconds=3600)


@router.get("/amap/{kind}/{z}/{x}/{y}")
async def amap(kind: str, z: int, x: int, y: int) -> Response:
    """高德栅格瓦片代理（vec=矢量路网 / img=影像）。

    为什么必须代理：演示机的浏览器**完全连不上外网**（实测连 Open-Meteo 都失败），
    而我们服务器能取到高德瓦片（实测 200）。代理顺带做磁盘缓存，重复浏览不再出网。
    """
    template = AMAP_HOSTS.get(kind)
    if template is None:
        raise HTTPException(status_code=404, detail="未知底图类型")
    # 四个子域轮换，避免单点限流
    host = template.replace("{1-4}", str((x + y) % 4 + 1))
    url = f"{host}&x={x}&y={y}&z={z}"
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    cached = _read_cache(key, ttl_seconds=30 * 86400)
    if cached is None:
        try:
            resp = None
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                for attempt in range(2):
                    resp = await client.get(url, headers={
                        "User-Agent": "Mozilla/5.0 (compatible; slope-sentinel/1.0)",
                        "Referer": "https://www.amap.com/",
                    })
                    if resp.status_code < 400:
                        break
                    if attempt == 0 and (resp.status_code == 429 or resp.status_code >= 500):
                        await asyncio.sleep(0.6)
                    else:
                        break
            assert resp is not None
            if not _host_allowed(str(resp.url)):
                raise HTTPException(status_code=502, detail="上游跳转到了未授权主机")
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"上游返回 {resp.status_code}")
            body = resp.content
            if len(body) > settings.tile_max_bytes:
                raise HTTPException(status_code=502, detail="瓦片过大，已拒绝")
            cached = (body, resp.headers.get("content-type", "image/png"))
            _write_cache(key, cached[0], cached[1])
        except HTTPException:
            raise
        except Exception as exc:               # noqa: BLE001
            log.warning("高德瓦片拉取失败 %s：%s", url, exc)
            raise HTTPException(status_code=502, detail=f"瓦片拉取失败：{exc}")
    body, ct = cached
    return Response(content=body, media_type=ct,
                    headers={"Cache-Control": "public, max-age=604800"})
