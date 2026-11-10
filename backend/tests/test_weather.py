"""P15 验收测试：天气接入（缓存 / 降级 / 权重折算）。

重点不是"能不能拉到天气"，而是**拉不到的时候会不会连累预警**：
外网失败必须降级、必须给 stale 标记、必须不抛异常。

运行：cd web/backend && python tests/test_weather.py
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库

from sqlalchemy import select  # noqa: E402

from database import SessionLocal, WeatherCache, init_db  # noqa: E402
from services import weather as W  # noqa: E402

LON, LAT = 110.96, 30.83


def clear() -> None:
    db = SessionLocal()
    try:
        for row in db.execute(select(WeatherCache)).scalars().all():
            db.delete(row)
        db.commit()
    finally:
        db.close()


def fake_payload(rain: float = 12.0, hours: int = 72) -> dict:
    base = datetime(2026, 9, 20, 0, 0, 0)
    times = [(base + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(hours)]
    precip = [rain / 24 if i < 24 else 0.0 for i in range(hours)]
    return {"hourly": {"time": times, "precipitation": precip,
                       "temperature_2m": [20.0 + i * 0.01 for i in range(hours)]}}


def main() -> None:
    init_db()
    clear()

    norm = W.normalize_open_meteo(fake_payload(rain=12.0), LON, LAT)
    assert norm["available"] is True and norm["source"] == "open-meteo"
    assert abs(norm["rain24h"] - 12.0) < 0.01, norm["rain24h"]
    assert abs(norm["rain72h"] - 12.0) < 0.01
    assert norm["weight_bonus"] == 0.20, norm
    print("归一化与权重：24h %.1f mm -> +%.2f" % (norm["rain24h"], norm["weight_bonus"]))

    # 1b) 天气现象分档：晴/雨/雷暴要有颜色与风险提示
    sunny = W.classify_weather(0, 0.0, 0.0)
    assert sunny["severity"] == 0 and sunny["phenomenon"] == "晴", sunny
    cloudy = W.classify_weather(3, 0.0, 1.0)
    assert cloudy["severity"] == 0 and cloudy["phenomenon"] == "阴", cloudy
    light = W.classify_weather(61, 0.2, 4.0)
    assert light["severity"] == 1, light
    mid = W.classify_weather(63, 1.2, 12.0)
    assert mid["severity"] == 2 and mid["severity_color"] == "#ffd166", mid
    heavy = W.classify_weather(65, 4.0, 30.0)
    assert heavy["severity"] == 3 and heavy["severity_color"] == "#ff8a4c", heavy
    storm = W.classify_weather(95, 0.0, 0.0)
    assert storm["severity"] == 4 and storm["phenomenon"] == "雷阵雨", storm
    assert storm["severity_color"] == "#ff4d6d"
    print("天气现象分档：晴/阴 0 档、小雨 1、中雨 2、大雨 3、雷暴 4（各带颜色与风险提示）")

    assert W.weight_bonus(0.5, 1.0)[0] == 0.0
    assert W.weight_bonus(3.0, 5.0)[0] == 0.10
    assert W.weight_bonus(25.0, 10.0)[0] == 0.30
    assert W.weight_bonus(0.1, 25.0)[0] == 0.05          # 只看 24h 会漏掉"过程雨"
    assert W.weight_bonus(0.1, 90.0)[0] == 0.10
    both = W.weight_bonus(60.0, 120.0)
    assert both[0] == 0.50, both
    print("权重分档：24h 三段 + 72h 过程雨三段，叠加后 0.5 封顶")

    calls = {"n": 0}

    async def ok_fetch(lon: float, lat: float) -> dict:
        calls["n"] += 1
        return W.normalize_open_meteo(fake_payload(rain=30.0), lon, lat)

    async def bad_fetch(lon: float, lat: float) -> dict:
        raise RuntimeError("模拟外网 500")

    original = W.fetch_open_meteo
    try:
        W.fetch_open_meteo = ok_fetch
        first = asyncio.run(W.get_weather(LON, LAT))
        assert first["available"] and first["cached"] is False
        second = asyncio.run(W.get_weather(LON, LAT))
        assert second["cached"] is True
        assert calls["n"] == 1, "缓存没生效，实际调用 %d 次" % calls["n"]
        print("缓存：30 分钟内第二次调用不再打外网")

        W.fetch_open_meteo = bad_fetch
        third = asyncio.run(W.get_weather(LON, LAT, force=True))
        assert third["available"] is True and third["stale"] is True, third
        assert "上一次结果" in third["weight_reason"], third["weight_reason"]
        print("降级：外网失败时返回上一次结果并标 stale，不抛异常")

        clear()
        empty = asyncio.run(W.get_weather(LON, LAT, force=True))
        assert empty["available"] is False and empty["weight_bonus"] == 0.0, empty
        print("无缓存 + 外网失败：available=false，权重 0，不抛异常")
    finally:
        W.fetch_open_meteo = original

    try:
        asyncio.run(W.fetch_qweather(LON, LAT))
        raise AssertionError("未配置和风凭证时不应成功")
    except RuntimeError as exc:
        assert "未配置" in str(exc)
    print("和风未配置凭证 -> 明确报错（交由降级逻辑处理）")

    # 7) 全国降水网格：有缓存用缓存、失败要降级、绝不抛异常
    clear()

    async def ok_grid() -> dict:
        return {"available": True, "source": "open-meteo", "count": 135, "wet": 9,
                "points": [{"lon": 104.0, "lat": 24.0, "precip": 0.4, "code": 80,
                            "severity": 1, "phenomenon": "阵雨"}]}

    async def bad_grid() -> dict:
        raise RuntimeError("模拟网格接口 500")

    original_grid = W.fetch_grid
    try:
        W.fetch_grid = ok_grid
        g1 = asyncio.run(W.get_weather_grid())
        assert g1["count"] == 135 and g1["cached"] is False
        g2 = asyncio.run(W.get_weather_grid())
        assert g2["cached"] is True, "网格也要走缓存"
        W.fetch_grid = bad_grid
        g3 = asyncio.run(W.get_weather_grid(force=True))
        assert g3["available"] is True and g3.get("stale") is True, g3
        clear()
        g4 = asyncio.run(W.get_weather_grid(force=True))
        assert g4["available"] is False and g4["points"] == [], g4
    finally:
        W.fetch_grid = original_grid
    print("全国降水网格：缓存 / 降级 / 无缓存三态都正常")

    print("\nP15 天气接入测试通过")


if __name__ == "__main__":
    main()
