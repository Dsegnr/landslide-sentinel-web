"""批量天气接口的契约测试（/api/weather/batch）。

大屏与现场页各要在地图上挂 20+ 个点位的天气。原先逐点请求，走公网时
每个请求有近 1 秒固定往返，光天气图层就要三四秒 —— 这个接口把 24 次并成 1 次。

要守住的三件事：
  1. **顺序与条数与输入一一对应**（前端按下标对齐，顺序错了就会张冠李戴）；
  2. 每条的 weather 字段与单点接口**同结构**（同一个取数函数）；
  3. 坏输入明确 400，不做"猜他想传什么"，也别让一个人一次拖 500 个点。

这里把取数函数替换成假的，测试不依赖外网，也不写天气缓存表。

运行：cd web/backend && python tests/test_weather_batch.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

import routers.weather as RW  # noqa: E402

CALLS: list[tuple[float, float]] = []


async def fake_get_weather(lon: float, lat: float, *, force: bool = False) -> dict:
    """假取数：把坐标原样回填，便于断言"哪一条对应哪个点"。"""
    CALLS.append((lon, lat))
    return {"available": True, "source": "test", "lon": lon, "lat": lat,
            "weight_bonus": 0.0, "weight_reason": "测试", "rain24h": 0.0, "rain72h": 0.0}


def main() -> None:
    from main import app

    original = RW.get_weather
    RW.get_weather = fake_get_weather
    try:
        with TestClient(app) as raw:
            client = authed_client(raw)

            code = raw.get("/api/weather/batch?points=110.96,30.83").status_code
            assert code == 401, f"未登录应 401，实际 {code}"
            print("[OK] 未登录 → 401")

            CALLS.clear()
            pts = [(110.96, 30.83), (111.50, 31.20), (110.96, 30.83)]
            q = ";".join(f"{a},{b}" for a, b in pts)
            body = client.get(f"/api/weather/batch?points={q}").json()
            assert body["count"] == len(pts), body["count"]
            assert [(i["lon"], i["lat"]) for i in body["items"]] == pts, body["items"]
            assert all(i["weather"]["available"] and i["weather"]["source"] == "test"
                       for i in body["items"])
            # 同一坐标只取一次（站点与设备可能落在同一格），但返回仍是等长 items
            assert CALLS == [(110.96, 30.83), (111.50, 31.20)], CALLS
            print(f"[OK] {len(pts)} 个点位 → items 顺序一一对应；重复坐标只取 1 次")

            # 与单点接口同结构：字段集合必须一致（前端两处共用同一个类型）
            single = client.get("/api/weather?lon=110.96&lat=30.83").json()
            batch_one = body["items"][0]["weather"]
            assert set(single) == set(batch_one), (sorted(single), sorted(batch_one))
            print(f"[OK] 批量与单点返回结构一致（{len(single)} 个字段）")

            bad = [("abc", 400), ("110.96", 400), ("110.96,30.83,1", 400),
                   ("200,30", 400), ("110.96,95", 400)]
            for raw_points, want in bad:
                code = client.get(f"/api/weather/batch?points={raw_points}").status_code
                assert code == want, f"{raw_points!r} 应 {want}，实际 {code}"
            many = ";".join(f"{100 + i * 0.01},30" for i in range(RW.MAX_BATCH_POINTS + 1))
            code = client.get(f"/api/weather/batch?points={many}").status_code
            assert code == 400, f"超上限应 400，实际 {code}"
            print(f"[OK] 坏输入与超过 {RW.MAX_BATCH_POINTS} 个点位 → 400")
    finally:
        RW.get_weather = original

    print("\n批量天气接口测试通过")


if __name__ == "__main__":
    main()
