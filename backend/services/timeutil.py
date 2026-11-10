"""时间输出工具。

约定：**数据库里统一存 UTC**（种子数据、实时落库都是 UTC），API 输出时补上时区标识
（`...Z`），前端再按浏览器本地时间显示。否则 `new Date("2026-09-13 23:13:02")`
会被当成"本地时间"解析，演示时会出现"系统显示的最近更新时间比本机时钟慢 8 小时"。
"""
from __future__ import annotations

from datetime import datetime, timezone


def iso_utc(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:                  # 库里是 naive，但按约定就是 UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
