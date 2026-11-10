"""应用配置：全部从环境变量 / .env 读取，代码里不出现任何真实密钥。"""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "边坡哨兵 Web API"
    version: str = "0.1.0"

    # 数据库：本地开发默认 SQLite（免装 MySQL 即可跑通），
    # 容器部署时由 docker-compose 注入 MySQL 连接串。
    database_url: str = f"sqlite:///{(BASE_DIR / 'data' / 'sentinel.db').as_posix()}"

    # 鉴权
    # 至少 32 字节（PyJWT 对短密钥会告警；生产请在 .env 换成随机串）
    jwt_secret: str = "dev-secret-change-me-at-least-32-bytes-long"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 720

    # 账号体系（本系统只要两种身份，不做三角色）：
    #   user  —— 普通用户，登录后看大屏（只读）
    #   admin —— 管理人员，用"密钥入口"登录，可确认告警、看审计日志
    app_username: str = "monitor"
    app_password: str = "sentinel2026"        # 首次启动自动建号用；生产请在 .env 改掉
    admin_key: str = "admin-key-change-me"    # 管理人员密钥；生产请在 .env 改掉
    admin_token_minutes: int = 240

    # 前端跨域来源
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    # 涂鸦云（留空则自动降级为模拟数据）
    tuya_access_id: str = ""
    tuya_access_key: str = ""
    tuya_endpoint: str = "https://openapi.tuyacn.com"
    tuya_poll_seconds: int = 60

    # 虚拟设备（无涂鸦凭证时的模拟数据源）
    # speedup 只影响**模拟数据**的位移推进速率，1.0 = 按真实时间推进；
    # 演示时调大可以看到曲线走动，但必须在答辩口径里说明这是模拟加速。
    virtual_speedup: float = 1.0

    # 模型
    model_dir: str = str(BASE_DIR / "models")

    # 单进程部署：指定前端构建产物（dist）目录时，由后端直接托管大屏，
    # 于是"一个端口 = 页面 + API + WebSocket"，适合没有 nginx/不能装 Docker 的机器。
    static_dir: str = ""

    # 现场记录的照片存放目录（用户上传），与视频等媒体目录分开
    upload_dir: str = str(BASE_DIR / "data" / "uploads")
    # 现场影像（现场视频/实景图）目录，演示期放大屏用的站点视频
    media_dir: str = str(BASE_DIR / "media")

    # 地图瓦片缓存目录（专业底图/雷达瓦片走后端代理，落盘可复用）
    tile_cache_dir: str = str(BASE_DIR / "data" / "tilecache")
    # 单个瓦片最大字节数（防止被当成下载器）
    tile_max_bytes: int = 4 * 1024 * 1024

    # 仅用于本地"响应式对照"检查：允许页面被 iframe 嵌套（生产必须保持 False，
    # 否则点击劫持防护失效）。启动时用 ALLOW_FRAMING=1 临时打开。
    allow_framing: bool = False

    # 告警通知（可选）：留空则只在日志里记一条，不外发
    # kind: wecom（企业微信机器人，默认）/ dingtalk（钉钉）/ feishu（飞书）
    #       / slack / generic（通用 JSON）
    # ⚠ URL 里含机器人密钥，属于凭据：只放 .env，别写进命令行或提交到仓库。
    alert_webhook_url: str = ""
    alert_webhook_kind: str = "wecom"
    alert_notify_min_level: int = 3        # 达到该等级才外发（默认 3 级「高度预警」）

    # 设备 -> 库水位站 绑定，格式 "device_id:station_id,device_id2:station_id2"。
    # 这是**部署配置**（哪台设备挨着哪个水文站），因此放配置而不是数据库；
    # 留空 = 全部按哨兵模式（只有硬件通道）运行。
    reservoir_bindings: str = ""
    # 涌浪点位绑定：device_id:site_id,device_id:site_id（见 services/wave_presets.py）
    wave_bindings: str = ""

    # 硬件直连接入（通信模块 → 服务器）：格式 "device_id:token,device_id2:token2"。
    # 每个设备一个令牌，走请求头 X-Device-Token，**不用人机账号的 JWT**。
    # 留空 = 关闭该入口（默认关闭），此时仍可用轮询/模拟数据。
    ingest_tokens: str = ""

    # 天气（只做"预警权重参比"，绝不参与是否报警的判定）
    # provider: open-meteo（免密钥，默认）/ qweather（和风，需要 key + 专属 host）
    weather_enabled: bool = True
    weather_provider: str = "open-meteo"
    weather_cache_minutes: int = 10          # 缓存窗口：要"实时"就短一点，10 分钟够用也不至于打爆配额
    qweather_key: str = ""
    qweather_host: str = ""                  # 形如 xxxxx.re.qweatherapi.com

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def ingest_token_map(self) -> dict[str, str]:
        """解析设备令牌表；格式不对的条目直接跳过（不静默接受半截配置）。"""
        out: dict[str, str] = {}
        for pair in self.ingest_tokens.split(","):
            pair = pair.strip()
            if not pair or ":" not in pair:
                continue
            dev, _, token = pair.partition(":")
            dev, token = dev.strip(), token.strip()
            if dev and token:
                out[dev] = token
        return out

    @property
    def tuya_configured(self) -> bool:
        return bool(self.tuya_access_id and self.tuya_access_key)

    @property
    def reservoir_binding_map(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for pair in self.reservoir_bindings.split(","):
            item = pair.strip()
            if not item or ":" not in item:
                continue
            device_id, station_id = (p.strip() for p in item.split(":", 1))
            if device_id and station_id:
                out[device_id] = station_id
        return out


settings = Settings()
