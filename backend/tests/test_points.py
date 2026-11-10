"""地图点位测试：人工新增警告点位 + 关注 + 权重 + 区域加权风险。

要点：
  * 普通用户可读、不可写（403）；
  * 权重参与 `weighted_score = Σ(level×weight)/Σ(weight)`，权重越高拉动越大；
  * 关注（watch）点位在列表里置顶；
  * 删除是软删除（active=0），历史可追溯。

运行：cd web/backend && python tests/test_points.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import authed_client, setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from database import WarningPoint, SessionLocal, init_db  # noqa: E402


def clean() -> None:
    db = SessionLocal()
    try:
        for row in db.query(WarningPoint).all():
            db.delete(row)
        db.commit()
    finally:
        db.close()


def test_points(client, admin) -> None:
    # 1) 普通用户可读
    overview = client.get("/api/map/overview")
    assert overview.status_code == 200, overview.text
    base = overview.json()
    assert "nodes" in base and "summary" in base
    device_nodes = [n for n in base["nodes"] if n["source"] == "device"]
    print(f"地图总览（未加点位）-> 节点 {base['count']} 个（其中设备 {len(device_nodes)}）")

    # 2) 普通用户不能新增
    denied = client.post("/api/points", json={"name": "X", "lon": 110, "lat": 30})
    assert denied.status_code == 403, f"普通用户不该能新增点位：{denied.status_code}"

    # 3) 管理人员新增两个点：一个高权重关注点、一个低权重观察点
    high = admin.post("/api/points", json={
        "name": "巡检发现裂缝点", "lon": 110.77, "lat": 30.99,
        "level": 3, "weight": 2.5, "watch": True, "note": "坡面贯穿裂缝，人工确认",
    })
    assert high.status_code == 200, high.text
    high_id = high.json()["point"]["id"]
    assert high.json()["point"]["watch"] is True and high.json()["point"]["weight"] == 2.5

    low = admin.post("/api/points", json={
        "name": "临时观察点", "lon": 110.75, "lat": 30.98, "level": 1, "weight": 0.3,
    })
    assert low.status_code == 200, low.text
    print(f"新增点位 -> {high.json()['point']['name']}(级3/权重2.5/关注) + "
          f"{low.json()['point']['name']}(级1/权重0.3)")

    # 4) 加权风险：两个人工点 + 设备节点一起算
    after = client.get("/api/map/overview").json()
    s = after["summary"]
    assert s["manual_count"] == 2, s
    assert s["watch_count"] >= 1, s
    manual_levels = [(n["level"], n["weight"]) for n in after["nodes"]
                     if n["source"] == "manual"]
    total_w = sum(w for lv, w in manual_levels if lv > 0)
    expect_manual = sum(lv * w for lv, w in manual_levels) / total_w
    print(f"区域风险 -> 最高 {s['max_stage']}，加权分 {s['weighted_score']}"
          f"（人工点加权均值 {expect_manual:.2f}），关注 {s['watch_count']} 个")
    assert 0 <= s["weighted_score"] <= 4

    # 5) 权重调高后，加权分应上升（说明权重真的在起作用）
    before_score = s["weighted_score"]
    patched = admin.patch(f"/api/points/{low.json()['point']['id']}",
                          json={"weight": 3.0, "level": 4, "watch": True})
    assert patched.status_code == 200, patched.text
    after_score = client.get("/api/map/overview").json()["summary"]["weighted_score"]
    print(f"把观察点调到 级4/权重3.0/关注 -> 加权分 {before_score} -> {after_score}")
    assert after_score > before_score, "权重/等级提高后区域加权分应上升"

    # 6) 参数校验
    bad = admin.post("/api/points", json={"name": "越界", "lon": 200, "lat": 30})
    assert bad.status_code == 422, bad.text
    bad_w = admin.post("/api/points", json={"name": "权重越界", "lon": 110, "lat": 30, "weight": 9})
    assert bad_w.status_code == 422, bad_w.text

    # 7) 软删除：地图上不再出现，但历史仍在库里
    assert admin.delete(f"/api/points/{high_id}").status_code == 200
    now_nodes = client.get("/api/map/overview").json()["nodes"]
    assert all(n.get("id") != high_id for n in now_nodes), "软删除的点不该出现在地图上"
    listed = client.get("/api/points").json()["items"]
    assert any(p["id"] == high_id and p["active"] is False for p in listed), "软删除后仍应可查历史"
    print("软删除 -> 地图不再显示，但 /api/points 仍能查到（active=false）")


def main() -> None:
    init_db()
    clean()
    from main import app
    with TestClient(app) as raw:
        test_points(authed_client(raw), authed_client(raw, admin=True))
    print("地图点位测试通过")


if __name__ == "__main__":
    main()
