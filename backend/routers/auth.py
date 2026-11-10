"""登录接口：普通用户（账号密码）+ 管理人员（密钥入口）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from config import settings
from database import AuditLog, SessionLocal
from services.auth import (Principal, authenticate, check_admin_key, create_token,
                           current_principal)
from services.security import client_ip, lock_remaining, record_failure, record_success

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


class AdminKeyBody(BaseModel):
    key: str


@router.post("/login")
def login(body: LoginBody, request: Request) -> dict:
    """普通用户登录：用户名 + 密码 -> JWT。"""
    ip = client_ip(request)
    remaining = lock_remaining(ip, body.username)
    if remaining > 0:
        # 429 + Retry-After：既挡住爆破，也给正常用户明确提示
        raise HTTPException(429, f"失败次数过多，请 {remaining // 60 + 1} 分钟后再试",
                            headers={"Retry-After": str(remaining)})
    if not authenticate(body.username, body.password):
        if record_failure(ip, body.username):
            _audit_lock(ip, body.username)
        raise HTTPException(401, "用户名或密码不正确")
    record_success(ip, body.username)
    token = create_token(body.username, "user")
    return {"token": token, "role": "user", "name": body.username,
            "expires_in": settings.jwt_expire_minutes * 60}


@router.post("/admin")
def admin_login(body: AdminKeyBody, request: Request) -> dict:
    """管理人员入口：直接对密钥，发一个短时效的 admin token。"""
    ip = client_ip(request)
    remaining = lock_remaining(ip, "admin")
    if remaining > 0:
        raise HTTPException(429, f"失败次数过多，请 {remaining // 60 + 1} 分钟后再试",
                            headers={"Retry-After": str(remaining)})
    if not check_admin_key(body.key):
        if record_failure(ip, "admin"):
            _audit_lock(ip, "admin")
        raise HTTPException(401, "管理人员密钥不正确")
    record_success(ip, "admin")
    token = create_token("admin", "admin", minutes=settings.admin_token_minutes)
    return {"token": token, "role": "admin", "name": "管理人员",
            "expires_in": settings.admin_token_minutes * 60}


@router.get("/me")
def me(principal: Principal = Depends(current_principal)) -> dict:
    return {"name": principal.name, "role": principal.role}


def _audit_lock(ip: str, username: str) -> None:
    """触发锁定时才写审计（每次失败都写会变成写放大攻击面）。"""
    db = SessionLocal()
    try:
        db.add(AuditLog(user_email=username, action="login_locked",
                        target="auth", detail=f"source={ip} 连续失败已锁定"))
        db.commit()
    finally:
        db.close()
