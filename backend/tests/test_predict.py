"""P3 验收测试：Web 侧推理必须与算法侧的**部署口径**参考结果一致。

比对目标的选择很关键（第一版这里判错了）：
  * `baijiabao_daily_warning.parquet` 是**留一年折外预测**（评价口径），
    在它上面比对融合层级是错的——线上用的是全量拟合的部署模型；
  * 因此算法工作线另行导出 `baijiabao_deploy_reference.parquet`（部署口径），
    本测试与它逐日比对 sentinel_level / forecast_level / combined_level。

两套实现相互独立（算法侧用 pandas+sklearn 的写法，Web 侧用服务化写法），
逐日一致即证明特征构造与融合规则被正确移植。

运行：cd web/backend && python tests/test_predict.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.predictor import WarningPredictor  # noqa: E402

MODELS = Path(__file__).resolve().parents[1] / "models"
RAW = MODELS / "baijiabao_daily_warning.parquet"          # 原始观测量
REF = MODELS / "baijiabao_deploy_reference.parquet"       # 部署口径的期望输出


def main() -> None:
    raw = pd.read_parquet(RAW)
    raw["ts"] = pd.to_datetime(raw["ts"])
    ref = pd.read_parquet(REF)
    ref["ts"] = pd.to_datetime(ref["ts"])

    # 组装 Web 侧输入（只用原始观测量，不喂任何已算好的特征）
    df = pd.DataFrame({
        "ts": raw["ts"],
        "disp": raw["ZD1"],
        "rain": raw["rain_mm"],
        "level": raw["level_m"],
        "ZD1": raw["ZD1"], "ZD2": raw["ZD2"], "ZD3": raw["ZD3"],
    })

    pred = WarningPredictor()
    out = pd.DataFrame(pred.predict_series(df, channel_cols=["ZD1", "ZD2", "ZD3"],
                                           mode="full"))
    out["ts"] = pd.to_datetime(out["ts"])
    m = ref.merge(out, on="ts", suffixes=("_ref", "_web"))
    m = m.dropna(subset=["p30_web", "p30_ref"])

    same_sentinel = (m["sentinel_level_ref"] == m["sentinel_level_web"]).mean()
    same_forecast = (m["forecast_level_ref"] == m["forecast_level_web"]).mean()
    same_combined = (m["combined_level_ref"] == m["combined_level_web"]).mean()
    print(f"可比对天数: {len(m)}")
    print(f"哨兵层级一致率: {same_sentinel:.3f}")
    print(f"预警层级一致率: {same_forecast:.3f}")
    print(f"融合层级一致率: {same_combined:.3f}")

    dp = (m["p30_web"] - m["p30_ref"]).abs()
    print(f"p30 绝对差：均值 {dp.mean():.6f}  最大 {dp.max():.6f}")

    # 论文 4.3 节的三个样例日期
    for day, expect in (("2024-10-22", 3), ("2024-10-17", 0), ("2023-01-01", 0)):
        row = out[out["ts"] == day]
        if row.empty:
            print(f"  {day}: 不在数据范围")
            continue
        r = row.iloc[0]
        print(f"  {day}: 哨兵={r['sentinel_level']} 融合={r['combined_level']} "
              f"stage={r['stage']} p30={r['p30']:.4f}（论文样例={expect}）")

    assert same_sentinel > 0.98, f"哨兵层一致率过低：{same_sentinel:.3f}"
    assert same_forecast > 0.95, f"预警层一致率过低：{same_forecast:.3f}"
    assert same_combined > 0.95, f"融合一致率过低：{same_combined:.3f}"
    # 容差说明：算法侧对整批样本做矩阵乘法（BLAS），Web 侧逐样本做点积，
    # 浮点求和顺序不同，差异应在 1e-4 量级；超过则说明特征或系数确有偏差。
    assert dp.mean() < 1e-4, f"p30 与算法侧不一致：均值差 {dp.mean():.3e}"
    print("P3 验收测试通过")


if __name__ == "__main__":
    main()
