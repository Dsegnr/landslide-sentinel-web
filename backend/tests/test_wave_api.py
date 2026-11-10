"""P27 验收测试：涌浪估算接口（GET /api/wave/presets、POST /api/wave）。

覆盖：鉴权（未登录 401）/ 预设列表 / 用预设估算 / 直接给参数 /
未知预设 404 / 缺参数 422 / 参数越界 422 / 两档并列结构 / 适用域越界标记。

运行：cd web/backend && python tests/test_wave_api.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)          # 独立测试库，不污染演示库

from fastapi.testclient import TestClient  # noqa: E402

from database import init_db  # noqa: E402
from services.auth import ensure_default_user  # noqa: E402
from main import app  # noqa: E402

PRESETS_URL = "/api/wave/presets"
URL = "/api/wave"


def main() -> None:
    init_db()
    ensure_default_user()          # 不走 lifespan，这里手动建默认账号
    raw = TestClient(app)
    client = authed_client(raw)

    # 1) 鉴权：未登录一律 401（与其它接口口径一致）
    assert raw.get(PRESETS_URL).status_code == 401
    assert raw.post(URL, json={"site": "baijiabao"}).status_code == 401
    print("[OK] 未登录 → 401（读接口也要登录）")

    # 2) 预设列表
    res = client.get(PRESETS_URL)
    assert res.status_code == 200, res.text
    data = res.json()
    ids = [p["id"] for p in data["presets"]]
    assert "baijiabao" in ids, ids
    assert set(data["limits"]) >= {"F", "S", "M", "P"}, data["limits"]
    print(f"[OK] 预设列表：{ids}；适用域键 {sorted(data['limits'])}")
    # 预设要如实标出还没确认的参数
    bj = next(p for p in data["presets"] if p["id"] == "baijiabao")
    assert bj["unconfirmed"], "预设必须标出待确认参数"
    print(f"[OK] 白家包预设标出待确认参数：{bj['unconfirmed']}")

    # 3) 用预设估算：两档并列 + 两个情景
    res = client.post(URL, json={"site": "baijiabao", "monitored_speed_mps": 0.02})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["preset"]["id"] == "baijiabao"
    assert len(out["rows"]) == 2, [r["scenario"] for r in out["rows"]]
    scenarios = {r["scenario"] for r in out["rows"]}
    assert scenarios == {"drop", "monitoring"}, scenarios
    for row in out["rows"]:
        assert "panjiazheng" in row and "heller" in row
        assert {"applicable", "unavailable_reason", "centroid_drop_m"} <= set(row["heller"])
        assert {"velocity_mps", "opposite_min_m", "opposite_max_m"} <= set(row["panjiazheng"])
    print("[OK] 两档并列：scenarios = drop / monitoring，各带 Heller 与潘家铮")

    # 4) 白家包：质心 151 m < 蓄水位 175 m → B 档**前提不成立，不出数**
    by_scen = {r["scenario"]: r for r in out["rows"]}
    hb = by_scen["drop"]["heller"]
    assert hb["applicable"] is False, hb
    # 预设里的质心高程 154 m 由 _tools/digitize_baijiabao_profile.py 程序化量算
    assert hb["centroid_drop_m"] == -21.0, hb["centroid_drop_m"]
    assert "没入水面" in hb["unavailable_reason"], hb["unavailable_reason"]
    assert "P" not in hb and "amplitude_max_m" not in hb, "不适用时不得给数值"
    assert by_scen["drop"]["panjiazheng"]["opposite_max_m"] > 0, "潘家铮档应照常给数"
    assert "无公开适用域" in by_scen["drop"]["panjiazheng"]["caveat"], "潘家铮档须如实标 caveat"
    print(f"[OK] 白家包 Δz_sc={hb['centroid_drop_m']} m → B 档不适用、不给数；潘家铮档照常出数")

    # 4b) Lituya 演示点位：B 档前提成立，且复现原文 a_M = 143 m
    res = client.post(URL, json={"site": "lituya"})
    assert res.status_code == 200, res.text
    li = res.json()["rows"]
    assert len(li) == 1, [r["scenario"] for r in li]
    hl = li[0]["heller"]
    assert hl["applicable"] is True and abs(hl["amplitude_max_m"] - 143) < 3, hl
    assert abs(hl["velocity_mps"] - 92) < 1.0, hl["velocity_mps"]
    print(f"[OK] Lituya 演示点位：v={hl['velocity_mps']} m/s、a_M={hl['amplitude_max_m']} m（原文 92 / 143）")

    # 5) 未知预设 → 404；缺参数 → 422；参数越界 → 422
    assert client.post(URL, json={"site": "nope"}).status_code == 404
    assert client.post(URL, json={}).status_code == 422
    assert client.post(URL, json={"site": "baijiabao", "alpha_deg": 95}).status_code == 422
    assert client.post(URL, json={"site": "baijiabao", "water_depth_m": -1}).status_code == 422
    print("[OK] 未知预设 404 / 缺参数 422 / alpha>90 与负水深 422")

    # 6) 直接给全部参数（不用预设）
    res = client.post(URL, json={
        "volume_m3": 4.9e6, "slide_width_m": 526.0, "water_width_m": 566.0,
        "water_depth_m": 85.0, "slide_thickness_m": 70.0, "drop_m": 85.0,
        "runout_m": 400.0, "slide_duration_s": 30.0, "alpha_deg": 40.0,
    })
    assert res.status_code == 200, res.text
    out2 = res.json()
    assert out2["preset"] is None
    assert out2["input"]["drop_m"] == 85.0
    print(f"[OK] 不用预设直接给参数：advisory={out2['summary']['advisory_m']} m")

    # 6b) 直接给参数时若缺质心/水面高程 → B 档同样拒绝出数（只能判、不能编）
    assert out2["rows"][0]["heller"]["applicable"] is False, out2["rows"][0]["heller"]
    assert "未提供" in out2["rows"][0]["heller"]["unavailable_reason"]
    print("[OK] 直接给参数但缺质心/水面高程 → B 档拒绝出数并说明缺什么")

    # 7) 对岸距离：低 X 时退化为 a_M 并如实标记（用 Lituya，B 档前提成立）
    res = client.post(URL, json={"site": "lituya", "opposite_distance_m": 823.0})
    row = res.json()["rows"][0]["heller"]
    assert row["at_opposite_uses_decay"] is False, row
    assert row["at_opposite_m"] == row["amplitude_max_m"], row
    print(f"[OK] 对岸 X<10 → 退化为 a_M={row['at_opposite_m']} m 并标记 uses_decay=False")

    # 8) 轮询状态接口（只读）：没有绑定/没跑过时返回空表，也必须受登录保护
    assert raw.get("/api/wave/status").status_code == 401
    res = client.get("/api/wave/status")
    assert res.status_code == 200, res.text
    status = res.json()
    assert "sites" in status, status
    print(f"[OK] 轮询状态接口可用（当前 {len(status['sites'])} 个点位有记录）")

    print("\nP27 涌浪接口测试通过")


if __name__ == "__main__":
    main()
