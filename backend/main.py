"""边坡哨兵 Web API 入口。

启动：python -m uvicorn main:app --host 0.0.0.0 --port 8081 --reload
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import settings
from database import init_db
from routers import (admin, alerts, auth, health, ingest, maptiles, ops, points,
                     predict, qr, records, sensors, stream, wave, weather)
from services.auth import ensure_default_user
from services.device_manager import manager
from services.ingest import polling_loop

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sentinel")

# .mjs 默认会被当成 text/plain，而**模块 Worker 要求 JavaScript MIME**，
# 否则 MapLibre 的瓦片解码线程起不来（地图空白）。静态托管前先登记好。
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    ensure_default_user()          # 首次启动按配置建一个普通用户（已存在则不动）
    log.info("数据库已就绪：%s", settings.database_url.split(":")[0])
    log.info("涂鸦凭证：%s", "已配置" if settings.tuya_configured else "未配置（自动使用模拟数据）")
    manager.apply_bindings(settings.reservoir_binding_map)
    full = [d.device_id for d in manager.all() if d.has_level]
    log.info("库水位绑定：%s", full or "无（全部按哨兵模式运行）")
    stop = asyncio.Event()
    task = asyncio.create_task(polling_loop(stop))
    try:
        yield
    finally:
        stop.set()
        await task
        log.info("服务关闭")


# 生产环境关掉自动接口文档（/docs、/redoc、/openapi.json）：它们会把**全部接口路径**
# 列出来（含管理接口），等于给外部一份免费的侦察清单——接口本身仍要鉴权，但没必要暴露路径。
# 本机开发（或需要看文档时）用 APP_ENV=dev 启动即可恢复。
_DEV = (os.getenv("APP_ENV", "prod").lower() in ("dev", "development", "local"))
app = FastAPI(
    title=settings.app_name, version=settings.version, lifespan=lifespan,
    docs_url="/docs" if _DEV else None,
    redoc_url="/redoc" if _DEV else None,
    openapi_url="/openapi.json" if _DEV else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 安全响应头：防 MIME 嗅探、防点击劫持、限制外部资源与表单提交目标。
# 注意 style-src 需要 'unsafe-inline'（React 的 style 属性属于内联样式），
# 但 script-src 保持 'self'——内联脚本一律禁止，这是防 XSS 的关键一条。
# worker-src blob: 是 MapLibre 需要的：它把矢量瓦片解码放在 Blob Worker 里跑，
# 只写 script-src 'self' 会把这个 worker 拦掉（表现为地图空白、样式永远加载不完）。
# 注：MapLibre 的瓦片解码跑在同源 worker 里，所以 worker-src 至少要有 'self'。
# （之前怀疑 CSP 拦了 Blob Worker，实测关掉 CSP 也一样，真正的坑在打包后的 worker 路径，
#   见前端 MapPro.tsx 里对 config.WORKER_URL 的设置。）
_CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self'; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; "
        "worker-src 'self' blob:; child-src 'self' blob:; "
        "connect-src 'self' ws: wss:; frame-ancestors 'none'; "
        "base-uri 'self'; form-action 'self'")


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # 允许嵌套只用于本地对照检查（ALLOW_FRAMING=1），生产必须保持 DENY
    if not settings.allow_framing:
        response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    csp = _CSP.replace("frame-ancestors 'none'; ",
                       "" if settings.allow_framing else "frame-ancestors 'none'; ")
    response.headers.setdefault("Content-Security-Policy", csp)
    return response

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(predict.router)
app.include_router(alerts.router)
app.include_router(sensors.router)
app.include_router(stream.router)
app.include_router(records.router)
app.include_router(points.router)
app.include_router(ingest.router)
app.include_router(weather.router)
app.include_router(maptiles.router)
app.include_router(wave.router)
app.include_router(ops.router)
app.include_router(qr.router)


# 现场照片（用户上传）与现场影像（视频/实景图）：直接静态挂载，
# 因为 <img>/<video> 标签带不了 Authorization 头。文件名是随机 UUID，不可枚举。
for _name, _dir in (("uploads", settings.upload_dir), ("media", settings.media_dir)):
    _path = Path(_dir)
    _path.mkdir(parents=True, exist_ok=True)
    app.mount(f"/{_name}", StaticFiles(directory=str(_path)), name=f"static-{_name}")
    log.info("静态资源挂载：/%s -> %s", _name, _path)


# 单进程模式：把前端构建产物挂在根路径（路由在前、静态挂载在后，
# 所以 /api、/ws、/docs 仍然优先命中）。适合"只能开一个端口"的机器。
_static = Path(settings.static_dir) if settings.static_dir else None
if _static and _static.is_dir():
    app.mount("/", StaticFiles(directory=str(_static), html=True), name="spa")
    log.info("已启用单进程模式，前端静态目录：%s", _static)

    @app.middleware("http")
    async def no_cache_html(request, call_next):
        """index.html 每次都回源校验。

        否则浏览器会把旧的 index.html 缓存住，继续引用**旧哈希**的 JS，
        重新部署后用户看到的还是老版本（这次就踩到了：服务器已是新包，浏览器仍跑旧包）。
        带哈希的 /assets/* 可以长缓存。
        """
        response = await call_next(request)
        path = request.url.path
        if path.endswith("/") or path.endswith(".html"):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif path.startswith("/assets/"):
            # 文件名带内容哈希：改名即新 URL，可以放心长缓存
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path.startswith(("/terrain/", "/field/", "/geo/")):
            # **不带哈希**的业务素材（DEM / OSM / 现场影像 / 省份底图）：内容会更新
            # 但 URL 不变，必须回源校验。实测踩到：白家包换了正确坐标、服务器上新 DEM
            # 已经就位，浏览器还在画旧的那座山。
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response
else:
    # 没有前端产物时，根路径给一个 JSON 说明（本地开发用）。
    # 注意：这里**不再回显 /docs 的地址**——它只存在于本地开发模式，没必要对外指路。
    @app.get("/")
    def root() -> dict:
        return {"app": settings.app_name, "version": settings.version,
                "hint": "前端产物未挂载：本机开发模式下可用 APP_ENV=dev 启动以查看接口文档"}
