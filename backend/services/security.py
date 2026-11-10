"""安全加固件：登录限流、上传内容嗅探。

设计取舍：
  * 限流用**进程内滑动窗口**（单实例部署够用，零依赖）；将来多实例时换成 Redis。
  * 按 "来源 IP + 用户名" 记账，避免一个账号被全网段锁死。
  * 上传不只信扩展名（改个后缀就能传脚本的套路），**再嗅探文件头**（magic bytes）。
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock

# 登录限流
FAIL_WINDOW_SECONDS = 300      # 统计窗口
MAX_FAILURES = 5               # 窗口内允许的失败次数
LOCK_SECONDS = 300             # 触发后锁定时间

_failures: dict[str, deque[float]] = defaultdict(deque)
_locked_until: dict[str, float] = {}
_lock = Lock()


def _key(ip: str, username: str) -> str:
    return f"{ip}|{username}"


def client_ip(request) -> str:
    """取真实来源 IP。

    坑：线上是用 cloudflared 隧道暴露的，所有外部请求在服务端看起来都来自 127.0.0.1——
    如果直接按 socket 地址限流，**一个人输错密码就会把所有人锁掉**（实测踩到过）。
    因此当对端是本机（说明经过隧道/反代）时，改用 Cloudflare 注入的
    `CF-Connecting-IP` / `X-Forwarded-For` 第一段。
    """
    peer = request.client.host if request.client else "unknown"
    if peer in ("127.0.0.1", "::1", "localhost"):
        for header in ("cf-connecting-ip", "x-forwarded-for"):
            value = request.headers.get(header)
            if value:
                return value.split(",")[0].strip()
    return peer


def lock_remaining(ip: str, username: str) -> int:
    """还剩多少秒解锁（0 = 未锁定）。"""
    now = time.time()
    with _lock:
        until = _locked_until.get(_key(ip, username), 0.0)
    return max(0, int(until - now))


def record_failure(ip: str, username: str) -> int:
    """登记一次失败；返回剩余锁定秒数（0 表示还没到锁定阈值）。"""
    now = time.time()
    key = _key(ip, username)
    with _lock:
        window = _failures[key]
        while window and now - window[0] > FAIL_WINDOW_SECONDS:
            window.popleft()
        window.append(now)
        if len(window) >= MAX_FAILURES:
            _locked_until[key] = now + LOCK_SECONDS
            window.clear()
            return LOCK_SECONDS
    return 0


def record_success(ip: str, username: str) -> None:
    key = _key(ip, username)
    with _lock:
        _failures.pop(key, None)
        _locked_until.pop(key, None)


def reset_state() -> None:
    """测试用：清空限流状态。"""
    with _lock:
        _failures.clear()
        _locked_until.clear()


# 上传内容嗅探
_SIGNATURES: list[tuple[bytes, str]] = [
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
]


def sniff_image_type(raw: bytes) -> str | None:
    """按文件头判断真实图片类型；不是图片返回 None（改后缀的脚本会被挡住）。"""
    head = raw[:16]
    for sig, ext in _SIGNATURES:
        if head.startswith(sig):
            return ext
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None
