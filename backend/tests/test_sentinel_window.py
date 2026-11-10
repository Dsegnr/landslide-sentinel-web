"""哨兵层口径回归测试（2026-09-16 修正）。

锁死两个性质，防止"每天北京 08:00 等级归零"的伪影回潮：
  A. **日尺度等价**：滚动 24 h 增量在纯日尺度数据上恒等于「前一条读数之差」，
     因此白家包论文那条线逐日不变 —— 用算法侧参考文件逐日比对。
  B. **消除日界伪影**：亚日采样跨越 UTC 日界时，滚动口径不塌，旧的自然日桶口径会塌。

运行：cd web/backend && python tests/test_sentinel_window.py
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from services.predictor import (  # noqa: E402
    SENTINEL_QUIET_HALF_DAYS, levels_from_z, onsets_from_daily,
    robust_location_scale, rolling_window_increment,
)

REF = pathlib.Path(__file__).resolve().parents[1] / "models" / "baijiabao_daily_warning.parquet"
ZD_COLS = ["ZD1", "ZD2", "ZD3"]


def check(name: str, cond: bool, detail: str = "") -> None:
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" :: {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def main() -> int:
    # A. 日尺度等价：滚动 24 h ≡ 前一条读数之差（所以白家包那条线不受影响）
    d = pd.read_parquet(REF)
    inc_roll = rolling_window_increment(d["ts"], d["ZD1"])
    inc_diff = d["ZD1"].astype(float).diff()
    both = np.isfinite(inc_roll) & np.isfinite(inc_diff)
    diff = np.abs(inc_roll[both] - inc_diff[both])
    check("日尺度上「滚动24h」恒等于「日增量」",
          float(diff.max()) < 1e-9, f"最大差 {float(diff.max()):.2e} mm（{int(both.sum())} 天）")

    # 用同一套 recipe（日增量 + 排除 onset±15d 的安静段 μ/σ + z≥5 连续3日）复算，
    # 必须与算法侧参考 sentinel_level 逐日一致。
    onsets = onsets_from_daily(d["ZD1"])
    zs = []
    for c in ZD_COLS:
        inc = d[c].astype(float).diff()
        quiet = np.ones(len(d), bool)
        for o in onsets:
            lo = max(0, o - SENTINEL_QUIET_HALF_DAYS)
            hi = min(len(d) - 1, o + SENTINEL_QUIET_HALF_DAYS)
            quiet[lo:hi + 1] = False
        med, sigma = robust_location_scale(inc[quiet])
        zs.append(((inc - med) / sigma).to_numpy())
    combined = np.where(np.isfinite(np.vstack(zs)), np.vstack(zs), -np.inf).max(axis=0)
    lvl, _ = levels_from_z(np.where(np.isfinite(combined), combined, 0.0), d["ts"], persist_days=3)
    ref = d["sentinel_level"].to_numpy()
    agree = int((lvl == ref).sum())
    check("白家包日尺度逐日复现算法侧参考", agree == len(ref),
          f"{agree}/{len(ref)}（参考分布 {dict(pd.Series(ref).value_counts().sort_index())}）")

    # B. 日界伪影：恒定速率下，滚动口径跨 UTC 00:00 不塌；旧的自然日桶口径塌
    rng = np.random.default_rng(7)
    rate_mm_per_day = 0.6
    # 常态基线：13 天日尺度，日增量 ~N(0, 0.05)（有真实抖动，σ 才非零）
    base_days = pd.date_range("2026-09-01", "2026-09-13", freq="1D")
    base_disp = np.cumsum(np.r_[0.0, 0.05 * rng.standard_normal(len(base_days) - 1)])
    # 加速段：分钟级恒定速率，横跨两整天，覆盖 UTC 00:00（= 北京 08:00）这个日界
    ts_min = pd.date_range("2026-09-14 00:00", "2026-09-16 00:05", freq="1min")
    mins = (ts_min - ts_min[0]).total_seconds().to_numpy() / 60.0
    min_disp = base_disp[-1] + mins * (rate_mm_per_day / 1440.0)
    raw = pd.DataFrame({
        "ts": base_days.append(ts_min),
        "disp": np.r_[base_disp, min_disp],
    }).sort_values("ts").reset_index(drop=True)

    roll = rolling_window_increment(raw["ts"], raw["disp"]).to_numpy()
    # 跨日界前后的滚动增量应一致（恒定速率 → 恒等于 rate）
    after = raw["ts"] == pd.Timestamp("2026-09-16 00:05")
    before = raw["ts"] == pd.Timestamp("2026-09-15 23:55")
    check("恒定速率下滚动增量恒等于日速率",
          abs(float(roll[before][0]) - rate_mm_per_day) < 1e-9
          and abs(float(roll[after][0]) - rate_mm_per_day) < 1e-9,
          f"23:55={float(roll[before][0]):.4f}  次日00:05={float(roll[after][0]):.4f}"
          f"  期望 {rate_mm_per_day}")
    check("跨 UTC 日界滚动增量不塌（差值 <0.1%）",
          abs(float(roll[after][0]) - float(roll[before][0])) < rate_mm_per_day * 1e-3)

    # 旧口径：按自然日取末值再 diff —— 跨日界后当天只有 5 分钟，增量塌成 1/288
    day = raw["ts"].dt.normalize()
    old_inc = raw.groupby(day)["disp"].last().diff()
    last = float(old_inc.iloc[-1])
    check("旧口径（自然日桶）跨日界后增量被系统性低估",
          last < rate_mm_per_day * 0.05,
          f"旧口径 {last:.5f} mm vs 真实 {rate_mm_per_day} mm"
          f"（仅 {last / rate_mm_per_day * 100:.1f}%）")

    # 同一个量的 z：滚动口径不被日界影响，旧口径会掉到噪声区
    mu, sigma = robust_location_scale(old_inc.dropna().iloc[:-1])
    z_new_after = (float(roll[after][0]) - mu) / sigma
    z_old_after = (last - mu) / sigma
    check("同一 z 口径下：新口径仍在高位、旧口径跌回噪声区",
          z_new_after > 5 > z_old_after,
          f"新 z={z_new_after:.1f}  旧 z={z_old_after:.2f}")

    # C. 覆盖回退：原始读数窗口远短于日尺度历史时，早期日行不能被截断成 0
    #    （sentinel_rolling 只拿得到最近 SENTINEL_RAW_DAYS 天的原始读数）
    from services.predictor import WarningPredictor

    pred = WarningPredictor(model_dir=pathlib.Path(__file__).resolve().parent / "_no_model")
    rng2 = np.random.default_rng(11)
    days = pd.date_range("2025-01-01", periods=200, freq="1D")
    step_day = 120                                   # 第 120 天来一次 20 mm 阶跃
    inc = 0.05 * rng2.standard_normal(len(days))
    inc[step_day] += 20.0
    daily = pd.DataFrame({"ts": days, "disp": np.cumsum(inc), "rain": 0.0})
    feat = pred.build_features(daily)

    # 原始读数只给最后 2 天（模拟 load_raw_series 的短窗口）
    ts_min = pd.date_range(days[-2], days[-1] + pd.Timedelta(hours=23, minutes=50),
                           freq="10min")
    raw_min = pd.DataFrame({
        "ts": ts_min,
        "disp": np.interp(ts_min.astype("int64"), days.astype("int64"),
                          daily["disp"].to_numpy()),
        "rain": 0.0,
    })
    # 2026-09-23：哨兵层新增第三个返回值（可用性掩码，用于区分"没数据"与"平静"）
    lvl, _, avail = pred.sentinel_rolling(raw_min, feat)
    at_step = int(lvl.iloc[step_day])
    check("原始窗口覆盖不到的早期日行不被截断成 0（保留日网格口径）",
          at_step >= 3, f"阶跃日等级 = {at_step}（若被截断会是 0）")
    check("输出长度与日尺度历史一致", len(lvl) == len(feat), f"{len(lvl)} vs {len(feat)}")
    # 第一行本来就没有"前一行"可比（diff 首行为空），标成不可用是正确的；
    # 其余行都该是可用的。
    check("可用性掩码长度一致，除首行外都可用",
          len(avail) == len(feat) and bool(avail.iloc[1:].all()),
          f"{int(avail.sum())}/{len(avail)} 行可用（首行无增量属正常）")

    print("\n哨兵层口径回归测试通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
