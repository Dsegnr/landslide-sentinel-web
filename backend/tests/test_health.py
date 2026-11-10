"""后端骨架冒烟测试：不依赖网络与涂鸦凭证。

运行：cd web/backend && python tests/test_health.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)          # 测试用独立数据库，避免污染演示库

from fastapi.testclient import TestClient  # noqa: E402

from database import init_db  # noqa: E402
from main import app  # noqa: E402


def main() -> None:
    init_db()
    with TestClient(app) as client:
        r = client.get("/api/health")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] in ("ok", "degraded"), body
        assert body["database"]["ok"] is True, body
        assert isinstance(body["models"], list)
        print("health ->", body)

        r = client.get("/")
        assert r.status_code == 200, r.text
        print("root   ->", r.json())
    print("P1 冒烟测试通过")


if __name__ == "__main__":
    main()
