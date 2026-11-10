"""登录鉴权：普通用户（用户名+密码）与管理人员（密钥入口）。

设计取舍（按队伍要求，不做三角色）：
  * **只保留两种身份**：
      - `user`  ：登录后看大屏，只读（不能确认告警、不能看审计）
      - `admin` ：用管理人员密钥进入，能确认告警、看审计日志与系统概览
  * 密码用 **bcrypt** 存储（不存明文，也就不用怕库被拿走）；
  * 登录成功后发 **JWT**（HS256），前端带 `Authorization: Bearer <token>`；
  * 管理人员**不建账号**，直接对 `.env` 里的 `ADMIN_KEY` 做常量时间比较后发 admin token，
    省掉"再加一个管理员账号体系"的复杂度（密钥泄漏就换密钥，改一行即可）。
"""
from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from config import settings
from database import SessionLocal, User

log = logging.getLogger("sentinel.auth")

bearer = HTTPBearer(auto_error=False)


@dataclass
class Principal:
    name: str
    role: str          # user | admin

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


# 密码
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# JWT
def create_token(subject: str, role: str, minutes: int | None = None) -> str:
    expire_minutes = minutes or settings.jwt_expire_minutes
    payload = {
        "sub": subject,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=expire_minutes),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(401, "登录已过期，请重新登录") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(401, "登录凭证无效") from exc


# 账号
def ensure_default_user() -> None:
    """首次启动按配置建一个普通用户；已存在则不动（避免覆盖别人改过的密码）。"""
    db = SessionLocal()
    try:
        row = db.execute(select(User).where(User.email == settings.app_username)).scalars().first()
        if row is None:
            db.add(User(email=settings.app_username, name="监测值班",
                        password_hash=hash_password(settings.app_password), role="user"))
            db.commit()
            log.info("已创建默认普通用户：%s", settings.app_username)
    finally:
        db.close()


def authenticate(username: str, password: str) -> bool:
    db = SessionLocal()
    try:
        row = db.execute(select(User).where(User.email == username)).scalars().first()
        if row is None or not row.is_active:
            return False
        return verify_password(password, row.password_hash)
    finally:
        db.close()


def check_admin_key(key: str) -> bool:
    """常量时间比较，避免"按键猜测耗时"这种低级旁路。"""
    expected = settings.admin_key or ""
    if not expected:
        return False
    return secrets.compare_digest(key or "", expected)


def set_password(username: str, password: str) -> bool:
    db = SessionLocal()
    try:
        row = db.execute(select(User).where(User.email == username)).scalars().first()
        if row is None:
            return False
        row.password_hash = hash_password(password)
        db.commit()
        return True
    finally:
        db.close()


# 依赖
async def current_principal(
    cred: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> Principal:
    if cred is None or not cred.credentials:
        raise HTTPException(401, "需要登录后访问")
    payload = decode_token(cred.credentials)
    return Principal(name=str(payload.get("sub", "")), role=str(payload.get("role", "user")))


async def require_admin(principal: Principal = Depends(current_principal)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(403, "该操作需要管理人员权限")
    return principal


def principal_from_token(token: str | None) -> Principal | None:
    """给 WebSocket 用：浏览器的 WS 不能带请求头，只能用 query 传 token。"""
    if not token:
        return None
    try:
        payload = decode_token(token)
    except HTTPException:
        return None
    return Principal(name=str(payload.get("sub", "")), role=str(payload.get("role", "user")))
