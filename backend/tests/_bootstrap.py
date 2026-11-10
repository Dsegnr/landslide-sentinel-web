"""测试公共引导：把测试数据写到**独立测试库**，避免污染演示库。

用法（每个测试文件在导入 `database` 之前调用）：

    from _bootstrap import setup
    setup(__file__)

原理：pydantic-settings 的优先级是「环境变量 > .env」，所以这里先设
`DATABASE_URL` 指向 `tests/test_sentinel.db`，随后 `import database` 拿到的就是测试库。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

TEST_DB = Path(__file__).resolve().parent / "test_sentinel.db"


def setup(test_file: str) -> Path:
    sys.path.insert(0, str(Path(test_file).resolve().parents[1]))
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{TEST_DB.as_posix()}")
    # 上传/媒体目录也指到测试目录，别把测试照片写进真实 data/
    os.environ.setdefault("UPLOAD_DIR", str(TEST_DB.parent / "uploads"))
    os.environ.setdefault("MEDIA_DIR", str(TEST_DB.parent / "media"))
    return TEST_DB


def ensure_min_series(device_id: str, days: int = 40) -> None:
    """测试库里没有足够历史时，补一段最小日序列（只补不删）。"""
    from datetime import datetime, timedelta, timezone

    from database import Prediction, SensorReading, SessionLocal, init_db

    init_db()
    db = SessionLocal()
    try:
        exists = db.query(SensorReading).filter(SensorReading.device_id == device_id).count()
        if exists >= days:
            return
        t0 = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
        disp = 8.0
        for i in range(days):
            disp += 0.05
            db.add(SensorReading(device_id=device_id, ts=t0 + timedelta(days=i),
                                 R=1.2, P=1.1, T=20.0, H=60.0, RN=1.0, S=40.0, D=disp))
            db.add(Prediction(device_id=device_id, ts=t0 + timedelta(days=i),
                              sentinel_level=1, forecast_level=0, combined_level=1,
                              stage="关注"))
        db.commit()
    finally:
        db.close()


# 鉴权辅助
def auth_token(client, admin: bool = False) -> str:
    """拿一个可用 token：普通用户用默认账号，管理员用密钥入口。"""
    from config import settings

    if admin:
        res = client.post("/api/auth/admin", json={"key": settings.admin_key})
    else:
        res = client.post("/api/auth/login",
                          json={"username": settings.app_username,
                                "password": settings.app_password})
    assert res.status_code == 200, f"获取 token 失败：{res.status_code} {res.text}"
    return str(res.json()["token"])


class AuthedClient:
    """给 TestClient 自动带上 Authorization 头的薄包装。

    接口加了登录保护后，测试里不必到处写 headers；`.token` 供 WebSocket 用
    （浏览器的 WS 不能带请求头，只能把 token 放 query）。
    """

    def __init__(self, client, token: str):
        self._client = client
        self.token = token
        self.headers = {"Authorization": f"Bearer {token}"}

    def get(self, url, **kw):
        kw.setdefault("headers", self.headers)
        return self._client.get(url, **kw)

    def post(self, url, **kw):
        kw.setdefault("headers", self.headers)
        return self._client.post(url, **kw)

    def delete(self, url, **kw):
        kw.setdefault("headers", self.headers)
        return self._client.delete(url, **kw)

    def patch(self, url, **kw):
        kw.setdefault("headers", self.headers)
        return self._client.patch(url, **kw)

    def request(self, method: str, url: str, **kw):
        """通用方法（安全自查里要遍历 GET/POST/PATCH/DELETE）。"""
        kw.setdefault("headers", self.headers)
        return self._client.request(method, url, **kw)

    def websocket_connect(self, url, **kw):
        return self._client.websocket_connect(url, **kw)

    def url_with_token(self, path: str) -> str:
        sep = "&" if "?" in path else "?"
        return f"{path}{sep}token={self.token}"


def authed_client(client, admin: bool = False) -> AuthedClient:
    return AuthedClient(client, auth_token(client, admin=admin))
