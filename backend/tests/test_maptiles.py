"""P19 安全测试：地图瓦片代理（新增的攻击面）。

瓦片代理是**匿名可访问**的（浏览器的 <img> 带不了 Authorization 头），
所以它必须自己扛住滥用：白名单、路径穿越、SSRF（含跳转）、大小上限。

运行：cd web/backend && python tests/test_maptiles.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from routers.maptiles import _allowed, _host_allowed  # noqa: E402


def main() -> None:
    client = TestClient(app)

    # 1) 白名单：只放行登记的目录前缀
    assert _allowed("https://tiles.openfreemap.org", "planet/2026/x/1/1.pbf")
    assert _allowed("https://tilecache.rainviewer.com", "v2/radar/abc/256/5/1/2/4/1_1.png")
    assert not _allowed("https://tiles.openfreemap.org", "planet-secret/x")
    assert not _allowed("https://tilecache.rainviewer.com", "v1/admin")
    assert not _allowed("http://169.254.169.254", "latest/meta-data/")
    print("[OK] 白名单：只放行登记前缀，未知主机一律拒绝")

    # 2) SSRF：跳转后的最终地址也必须白名单内
    assert _host_allowed("https://tilecache.rainviewer.com/v2/radar/x.png")
    assert _host_allowed("https://webrd01.is.autonavi.com/appmaptile?x=1")
    assert not _host_allowed("http://127.0.0.1:39000/api/admin/overview")
    assert not _host_allowed("http://169.254.169.254/latest/meta-data/")
    assert not _host_allowed("https://evil.example.com/tile.png")
    print("[OK] SSRF 防护：跳转后的内网/外部主机一律拒绝")

    # 3) 未知前缀 / 未知底图类型 → 404，不泄露上游信息
    for url in [
        "/api/map/openfreemap/secret/x",
        "/api/map/openfreemap/planet-other/1/1/1.pbf",
        "/api/map/amap/evil/1/1/1",
        "/api/map/radar/v1/other",
    ]:
        res = client.get(url)
        assert res.status_code == 404, f"{url} 应 404，实际 {res.status_code}"
    print("[OK] 未知前缀/类型 → 404（不暴露上游）")

    # 4) 路径穿越：编码后的 ../ 不能逃出白名单
    for url in [
        "/api/map/openfreemap/planet/../../../etc/passwd",
        "/api/map/openfreemap/planet%2f..%2f..%2fetc%2fpasswd",
        "/api/map/amap/vec/../../admin",
    ]:
        res = client.get(url)
        assert res.status_code in (404, 400, 422), f"{url} 应被拒，实际 {res.status_code}"
    print("[OK] 路径穿越 → 被拒（404/400/422）")

    # 5) 非法的 z/x/y：不应 500，也不应真的去打上游
    for url in ["/api/map/amap/vec/abc/1/1", "/api/map/amap/vec/99/999999999/1"]:
        res = client.get(url)
        assert res.status_code != 500, f"{url} 不应 500"
    print("[OK] 非法瓦片坐标 → 不 500（参数校验生效）")

    # 6) 瓦片代理是匿名的（<img> 带不了头），但**管理类接口仍然要鉴权**
    assert client.get("/api/map/amap/vec/1/1/1").status_code in (200, 404, 502)
    for url in ["/api/devices", "/api/admin/overview", "/api/weather?lon=110&lat=30"]:
        assert client.get(url).status_code == 401, f"{url} 应要求登录"
    print("[OK] 瓦片匿名可用，但业务接口仍需鉴权（401）")

    # 7) 缓存目录只在配置目录内（拼出来的路径不越界）
    from routers.maptiles import _cache_path

    p = _cache_path("a" * 40)
    assert "tilecache" in str(p) and ".." not in str(p)
    print("[OK] 缓存路径固定落在配置的缓存目录内")

    print("\nP19 瓦片代理安全测试通过")


if __name__ == "__main__":
    main()
