"""雨量两类通道的口径测试（2026-09-23 定）。

现场装的是**平面雨量传感器**：它给的是表面湿润程度百分比（0 干燥、100 完全浸润，
可连续变化），**不是毫米雨量**。硬件负责人已当面确认这个口径。

所以要守住三件事：
  1. 百分比只能进 `RN`，且 0–100 之外一律拒收（否则"湿度 150"会被当数据存下来）；
  2. 毫米雨量只能进 `RNM`（留给能出毫米的雨量计）；
  3. **模型特征里的"降雨"只取 `RNM`** —— 把百分比当毫米累加是没有物理意义的。

运行：cd web/backend && python tests/test_rain_channels.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)

from services.ingest import IngestError, normalize_channels  # noqa: E402


def main() -> None:
    # 1) RN：感应强度百分比，两端都合法
    assert normalize_channels({"RN": 0})["RN"] == 0.0
    assert normalize_channels({"RN": 100})["RN"] == 100.0
    assert normalize_channels({"RN": 37.5})["RN"] == 37.5

    # 2) 越界必须报错，且提示要指明"毫米雨量请走 RNM"
    for bad in (100.1, 150, -1):
        try:
            normalize_channels({"RN": bad})
        except IngestError as exc:
            assert "RN" in str(exc), exc
            if bad > 100:
                assert "RNM" in str(exc), f"越界提示应指向 RNM：{exc}"
        else:
            raise AssertionError(f"RN={bad} 应当被拒收")

    # 3) RNM（mm）合法：0 到任意大（一次补传可能很大）
    assert normalize_channels({"RNM": 0})["RNM"] == 0.0
    assert normalize_channels({"RNM": 42.5})["RNM"] == 42.5
    try:
        normalize_channels({"RNM": -0.5})
    except IngestError:
        pass
    else:
        raise AssertionError("负雨量应当被拒收")

    # 4) 两个通道并存（硬件可能只有百分比，补齐序列两个都写）
    both = normalize_channels({"RN": 85, "RNM": 12.3})
    assert both["RN"] == 85.0 and both["RNM"] == 12.3

    # 5) 未知通道依旧报错（不许悄悄写进来）
    try:
        normalize_channels({"RNMM": 1})
    except IngestError:
        pass
    else:
        raise AssertionError("未知通道应当报错")

    print("[OK] RN = 雨量感应强度 %（0–100，越界拒收并提示改走 RNM）")
    print("[OK] RNM = 降雨量 mm（负值拒收）")
    print("\n雨量双通道口径测试通过")


if __name__ == "__main__":
    main()
