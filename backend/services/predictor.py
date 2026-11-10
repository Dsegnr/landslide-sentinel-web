"""滑坡预警推理：加载算法工作线的模型，输出与论文一致的分级结果。

设计要点（见 docs/Web实现计划.md 第五节）：
  * 预警层是 **12 维逻辑回归**，系数与归一化参数存在 JSON 里，不需要 PyTorch/ONNX；
  * 哨兵层是**纯规则**（逐通道稳健 z → 通道取或 → 持续去抖），无参数需要加载；
  * 融合规则与论文一致：combined = max(哨兵级, 预警级)，两层同时 >=2 时再 +1（上限 4）。

特征构造**必须与算法侧 experiments/models/baijiabao_short_horizon_warning.py 完全一致**，
否则线上线下会不一致（这是最容易被忽略的坑，故此处逐行对齐）。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from config import settings

log = logging.getLogger("sentinel.predictor")

LEVEL_NAME = {0: "平静", 1: "关注", 2: "预警", 3: "高度预警", 4: "警报"}
LEVEL_ADVICE = {
    0: "正常监测，无需动作",
    1: "加密数据巡检，留意趋势",
    2: "安排现场核查，准备应急预案",
    3: "启动应急值守，限制坡下通行",
    4: "立即避险转移并上报",
}

STEP_MM = 5.0

# ==== 哨兵层口径（2026-09-16 修正）====
# 旧实现把亚日采样压成"自然日桶"再取日增量。库里 ts 是 UTC，于是日界落在北京 08:00；
# 跨日界后"当天"只有几分钟数据，日增量从 +12.8 mm 塌到 +0.03 mm，等级每天固定在 08:00
# 掉到 0（实测：09-15、09-16 两次）。这是**聚合口径**的伪影，不是数据变好。
#
# 修正：当前值改用**滚动窗口增量**（默认 24 h），与日界、时区彻底无关；
# 而 μ/σ 参考段仍在**均匀日网格**上估计——直接在原始读数上估会被采样密度带偏
# （密集时段权重被放大：演示库里 μ 从 0.03 被拉到 19.6）。
#
# 口径与算法侧 `experiments/models/baijiabao_end_to_end.py` 对齐的部分：
#   * 日增量 + 稳健中位/MAD
#   * μ/σ 取自**排除 onset ±15 天**的安静段
#   * z≥5 持续判据；算法侧是「连续 3 天」，这里是等价的「连续 72 小时」
# 用该口径在白家包日尺度上复算，与算法侧参考 sentinel_level **2467/2467 逐日完全一致**。
SENTINEL_WINDOW_HOURS = 24.0          # 当前值：滚动窗口长度
SENTINEL_MATCH_TOLERANCE_HOURS = 6.0  # 找 t-window 时的匹配容差（历史缺测时不硬凑）
SENTINEL_QUIET_HALF_DAYS = 15         # μ/σ 参考段排除 onset ±N 天
SENTINEL_PERSIST_DAYS = 3             # 与算法侧一致：连续 3 个采样日 → 首末相隔 2 天


def rolling_window_increment(ts: pd.Series, values: pd.Series,
                             window_hours: float = SENTINEL_WINDOW_HOURS,
                             tolerance_hours: float = SENTINEL_MATCH_TOLERANCE_HOURS
                             ) -> pd.Series:
    """对每条读数，取 `values(t) − values(t − window)`。

    用 `merge_asof` 而不是手算整数纳秒：pandas 的 datetime64 不保证是 ns 单位，
    手算会整段失效（本次调试踩过）。找不到对应历史（历史不够长 / 缺口超过容差）
    的行返回 NaN——**绝不硬凑**，宁可不给结论。
    """
    left = pd.DataFrame({"ts": pd.to_datetime(ts), "value": np.asarray(values, float)})
    left = left.sort_values("ts").reset_index(drop=True)
    right = pd.DataFrame({
        "ts": left["ts"] + pd.Timedelta(hours=window_hours),
        "value_ref": left["value"].to_numpy(),
    }).sort_values("ts")
    m = pd.merge_asof(left, right, on="ts", direction="backward",
                      tolerance=pd.Timedelta(hours=tolerance_hours))
    return pd.Series((m["value"] - m["value_ref"]).to_numpy(), index=left.index)


def onsets_from_daily(zd: pd.Series, step_mm: float = STEP_MM) -> np.ndarray:
    """onset 定义与算法侧一致：7 日增量的上升沿。"""
    v = pd.Series(zd).astype(float).interpolate(limit=3, limit_area="inside")
    d7 = (v - v.shift(7)).to_numpy()
    active = np.nan_to_num(d7, nan=-1e9) > step_mm
    return np.flatnonzero(active & ~np.r_[False, active[:-1]])


def robust_location_scale(values: pd.Series,
                          floor: float = 1e-6) -> tuple[float, float]:
    """稳健中位 / MAD 尺度（与算法侧同一套）。"""
    ref = pd.Series(values).dropna().astype(float)
    if ref.empty:
        return 0.0, max(floor, 1.0)
    med = float(np.median(ref))
    sigma = max(float(np.median(np.abs(ref - med)) * 1.4826), floor)
    return med, sigma


def levels_from_z(z: np.ndarray, ts: pd.Series,
                  persist_days: int = SENTINEL_PERSIST_DAYS,
                  thr: float = 5.0) -> tuple[np.ndarray, np.ndarray]:
    """z → 0–4 级。4 级要求 z≥thr **连续持续**（按时间戳算，不按行数）。

    「连续 3 个采样日」等价于首末相隔 ≥2 天，这样日尺度数据上的结果与算法侧逐日一致，
    而亚日采样时又不会被"行数"糊弄。
    """
    zz = np.nan_to_num(np.asarray(z, float), nan=0.0)
    lvl = np.where(zz < 2.5, 0, np.where(zz < 4.0, 1, np.where(zz < 5.0, 2, 3))).astype(int)
    alarm = np.zeros(len(zz), bool)
    t = pd.to_datetime(ts).to_numpy()
    span = np.timedelta64(int(max(0, persist_days - 1) * 86400), "s")
    start = None
    for i in range(len(zz)):
        if zz[i] >= thr:
            if start is None:
                start = t[i]
            alarm[i] = (t[i] - start) >= span
        else:
            start = None
    lvl[alarm] = 4
    return lvl, alarm


@dataclass
class ForecastModel:
    horizon: int
    feats: list[str]
    mean: np.ndarray
    scale: np.ndarray
    coef: np.ndarray
    intercept: float
    thresholds: dict

    def probability(self, x: np.ndarray) -> float | None:
        """特征含缺失（例如库水位缺口、前 90 天窗口未就绪）时返回 None，
        而不是把 NaN 一路算成概率——`np.digitize(NaN)` 会落在最后一个分箱里，
        静默产出一个"高等级预警"，这是最危险的一类假信号。"""
        x = np.asarray(x, float)
        if not np.isfinite(x).all():
            return None
        z = (x - self.mean) / self.scale
        return float(1.0 / (1.0 + np.exp(-np.clip(z @ self.coef + self.intercept, -50, 50))))

    def level(self, p: float) -> int:
        return int(np.digitize(p, np.asarray(self.thresholds[str(self.horizon)], float)))


@dataclass
class Warning:
    ts: str
    mode: str
    p7: float | None
    p30: float | None
    sentinel_level: int
    sentinel_channels: list[str]
    forecast_level: int | None
    combined_level: int
    stage: str
    advice: str
    # 当前这一行的等级是**算得出来的**，还是"没有有效读数、无从判断"。
    # 见 `sentinel_rolling` 的说明：这个区分不能省 —— 把"没数据"当成"平静"
    # 是预警系统里最危险的一种谎（设备掉线会被读成一切正常）。
    data_available: bool = True
    notes: list[str] = field(default_factory=list)


class WarningPredictor:
    """加载模型 + 构造特征 + 哨兵层规则 + 融合，输出与论文一致的结果。"""

    def __init__(self, model_dir: str | Path | None = None):
        d = Path(model_dir or settings.model_dir)
        self.models: dict[int, ForecastModel] = {}
        for h in (7, 30):
            p = d / f"baijiabao_forecast_{h}d.json"
            if p.exists():
                raw = json.loads(p.read_text(encoding="utf-8"))
                self.models[h] = ForecastModel(
                    horizon=h, feats=raw["feats"],
                    mean=np.asarray(raw["mean"], float),
                    scale=np.asarray(raw["scale"], float),
                    coef=np.asarray(raw["coef"], float),
                    intercept=float(raw["intercept"]),
                    thresholds=raw["thresholds"],
                )
        log.info("已加载预警层模型：%s", sorted(self.models))

    # 采样率
    @staticmethod
    def to_daily(df: pd.DataFrame) -> pd.DataFrame:
        """把亚日采样（硬件分钟/秒级）聚合为**日尺度**，与论文协议对齐。

        在线下料与硬件采样率不一致是线上最容易翻车的地方：论文的 7/14/30 日窗口
        是按"行"移位的，若直接喂分钟级数据，`shift(7)` 实际只回溯了 7 分钟，
        哨兵层的日增量 z 也会被瞬时噪声淹没。

        规则：位移取当日最后一条（累积量）、雨量取当日累加、其余通道取当日最后一条。
        **不补齐缺失日期**——算法侧是按行移位，插入空行会改变窗口含义，
        因此只做"同一自然日的多行合并"，缺测日仍然缺测（与算法侧口径一致）。
        """
        d = df.copy()
        if d.empty:
            return d
        d["ts"] = pd.to_datetime(d["ts"])
        d = d.sort_values("ts")
        day = d["ts"].dt.normalize()
        if not day.duplicated().any():
            return d                              # 已是日尺度：原样返回，保证与算法侧逐日一致
        agg = {c: "last" for c in d.columns if c != "ts"}
        if "rain" in agg:
            agg["rain"] = "sum"
        g = d.groupby(day, sort=True)
        out = g.agg(agg)
        out["ts"] = g["ts"].last()
        return out.reset_index(drop=True)[list(df.columns)]

    # 特征
    @staticmethod
    def build_features(df: pd.DataFrame) -> pd.DataFrame:
        """输入 ts / disp（位移 mm）/ rain（mm/d）/ 可选 level（库水位 m）；
        输出与算法侧同名同序的 12 个特征。"""
        d = df.copy()
        d["ts"] = pd.to_datetime(d["ts"])
        d = d.sort_values("ts").reset_index(drop=True)
        # 与算法侧 build() 完全一致：只补 3 个点以内的内部缺口，不做双向填充
        d["zd"] = d["disp"].astype(float).interpolate(limit=3, limit_area="inside")

        for w in (7, 14, 30):
            d[f"d_zd_{w}"] = d["zd"] - d["zd"].shift(w)

        active = (d["d_zd_7"] > STEP_MM).fillna(False).to_numpy()
        onset = active & ~np.r_[False, active[:-1]]
        idx = np.flatnonzero(onset)
        since = np.full(len(d), 999.0)
        for i in range(len(d)):
            prev = idx[idx < i]
            if len(prev):
                since[i] = i - prev[-1]
        d["days_since_onset"] = since

        if "level" in d.columns and d["level"].notna().any():
            lv = d["level"].astype(float).interpolate(limit=3, limit_area="inside")
            for w in (7, 30, 90):
                d[f"draw_{w}"] = lv.shift(w) - lv
            d["level_anom90"] = lv - lv.rolling(90, min_periods=30).mean()
        else:
            for w in (7, 30, 90):
                d[f"draw_{w}"] = np.nan
            d["level_anom90"] = np.nan

        rain = d["rain"].astype(float).fillna(0.0) if "rain" in d.columns else pd.Series(0.0, index=d.index)
        for w in (7, 30):
            d[f"rain_{w}"] = rain.rolling(w, min_periods=1).sum()

        doy = d["ts"].dt.dayofyear.to_numpy()
        d["sin_doy"] = np.sin(2 * np.pi * doy / 365)
        d["cos_doy"] = np.cos(2 * np.pi * doy / 365)
        return d

    # 融合
    @staticmethod
    def fuse(sentinel_level: int, forecast_level: int | None) -> tuple[int, bool]:
        f = 0 if forecast_level is None else int(forecast_level)
        combined = max(int(sentinel_level), f)
        dual = int(sentinel_level) >= 2 and f >= 2
        return (min(4, combined + 1) if dual else combined), dual

    # 哨兵层（滚动窗口版）
    def sentinel_rolling(self, raw: pd.DataFrame, feat_daily: pd.DataFrame,
                         channel_cols: list[str] | None = None
                         ) -> tuple[pd.Series, pd.Series, pd.Series]:
        """返回与 `feat_daily` 行对齐的 (level, 触发通道)。

        与旧 `sentinel()` 的区别只有一处，但很关键：

        * **当前值**在**原始读数**上按滚动窗口求增量，与自然日边界、时区无关
          → 消除"每天北京 08:00 归零"的伪影（旧实现按 UTC 自然日分桶，跨桶后
          "当天"只有几分钟数据，日增量被系统性低估）。
        * **μ/σ** 仍在**均匀日网格**上估计（排除 onset ±15 天）：直接在原始读数上估会被
          采样密度带偏（密集时段样本多、权重被放大，实测 μ 会从 0.03 被拉到 19.6）。
        * 纯日尺度数据（每天 1 条）下"滚动 24 h"恒等于"前一条读数"→ **与旧实现逐日等价**，
          白家包论文那条线不受影响（实测逐日完全一致）。

        实现上先算两套 z，再**按覆盖范围覆盖**：原始读数窗口（默认 10 天）覆盖到的日行用
        滚动口径，覆盖不到的更早历史保留日网格口径。这样"当下"没有伪影，而长历史的
        等级序列不会被截断成 0。

        第三个返回值是**可用性掩码**（2026-09-23 追加）：这一步的 z 是不是**真的算出来了**。

        为什么必须有它：旧实现把算不出的 z 用 `np.nan_to_num(nan=0.0)` 统一填成 0，
        于是"没有任何有效读数"被判成 **0 级平静** —— 设备掉线、通道全空、整段数据
        停更，大屏上都显示"正常监测，无需动作"。这是预警系统里最危险的一种谎。
        现在不可用的行单独标出来，等级照旧给 0（维持 0–4 契约），但调用方
        据此**不下发告警、并在界面上显示"数据不足"**。
        """
        want = channel_cols or ["disp"]
        cols = [c for c in want if c in raw.columns and c in feat_daily.columns]
        if not cols or raw.empty or feat_daily.empty:
            idx = feat_daily.index
            return (pd.Series(0, index=idx), pd.Series("", index=idx),
                    pd.Series(False, index=idx))

        onsets = (onsets_from_daily(feat_daily["disp"])
                  if "disp" in feat_daily.columns else np.array([], dtype=int))

        def combined_z(parts: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
            """多通道取最大 z（与算法侧 `Z.max(axis=1)` 一致）。"""
            Z = np.where(np.isfinite(np.vstack(parts)), np.vstack(parts), -np.inf)
            m = Z.max(axis=0)
            has = np.isfinite(m)
            return np.where(has, m, np.nan), np.where(has, Z.argmax(axis=0), -1)

        z_daily, z_roll = [], []
        for c in cols:
            daily_inc = feat_daily[c].astype(float).diff()
            quiet = np.ones(len(feat_daily), bool)
            for o in onsets:                        # 与算法侧一致：排除阶跃前后 ±15 天
                lo = max(0, o - SENTINEL_QUIET_HALF_DAYS)
                hi = min(len(feat_daily) - 1, o + SENTINEL_QUIET_HALF_DAYS)
                quiet[lo:hi + 1] = False
            med, sigma = robust_location_scale(daily_inc[quiet])
            z_daily.append(((daily_inc - med) / sigma).to_numpy())
            inc = rolling_window_increment(raw["ts"], raw[c])
            z_roll.append(((inc.to_numpy() - med) / sigma))

        # ① 日网格口径：全历史可用，也是论文那条线的口径
        z_d, arg_d = combined_z(z_daily)
        avail_daily = np.isfinite(z_d)
        lvl, _ = levels_from_z(np.nan_to_num(z_d, nan=0.0), feat_daily["ts"],
                               persist_days=SENTINEL_PERSIST_DAYS)
        arg = arg_d

        # ② 滚动窗口口径：只覆盖原始读数窗口内的时段，覆盖到的地方**覆盖①**。
        #    日行的 ts 就是该日最后一条原始读数的 ts，所以可以直接对齐。
        z_r, arg_r = combined_z(z_roll)
        lvl_r, _ = levels_from_z(np.nan_to_num(z_r, nan=0.0), raw["ts"],
                                 persist_days=SENTINEL_PERSIST_DAYS)
        per_ts = pd.DataFrame({"lvl": lvl_r, "z": z_r, "arg": arg_r},
                              index=pd.to_datetime(raw["ts"]).to_numpy())
        per_ts = per_ts[~per_ts.index.duplicated(keep="last")]
        idx = pd.to_datetime(feat_daily["ts"])
        r_lvl = per_ts["lvl"].reindex(idx).to_numpy()
        r_ok = per_ts["z"].reindex(idx).notna().to_numpy()
        r_arg = per_ts["arg"].reindex(idx).to_numpy()
        # 覆盖不到的更早日期保留① —— 纯日尺度数据下两者本就相等，所以无缝衔接
        lvl = np.where(r_ok, np.nan_to_num(r_lvl, nan=0.0).astype(int), lvl)
        arg = np.where(r_ok, r_arg, arg)
        # 滚动口径覆盖到就用它；没覆盖到则看日网格口径**那一行**是否真的算出了 z
        avail = np.where(r_ok, True, avail_daily)

        lvl = pd.Series(np.asarray(lvl, int), index=feat_daily.index)
        ch = pd.Series("", index=feat_daily.index)
        for i, a in enumerate(arg):
            if np.isfinite(a) and a >= 0:
                ch.iloc[i] = cols[int(a)]
        return lvl, ch, pd.Series(avail, index=feat_daily.index)

    # 主流程
    def predict_series(self, df: pd.DataFrame, channel_cols: list[str] | None = None,
                       mode: str | None = None,
                       raw_df: pd.DataFrame | None = None) -> list[dict]:
        """对整段序列逐日推理；返回列表，最后一项即"当下"。

        `df` 是**日尺度**帧（预警层的输入，也是历史序列的输出）。
        `raw_df` 是**未聚合的原始读数**，只给哨兵层的滚动窗口用——不传时退回 `df`
        （纯日尺度数据下两者等价，行为与旧版一致）。
        """
        # 两个帧各司其职，**不能合并**：
        #   daily —— 长历史日尺度（预警层特征 + 历史序列输出）
        #   raw   —— 短历史原始读数（哨兵层滚动窗口）
        raw = raw_df if (raw_df is not None and not raw_df.empty) else df
        daily = self.to_daily(df)                  # 亚日采样 -> 日尺度（日尺度输入时不变）
        feat = self.build_features(daily)
        s_lvl, s_ch, s_avail = self.sentinel_rolling(raw, feat, channel_cols)
        has_level = "level" in daily.columns and daily["level"].notna().any()
        mode = mode or ("full" if (has_level and self.models) else "sentinel_only")

        probs: dict[int, np.ndarray] = {}
        if mode == "full":
            for h, m in self.models.items():
                vals = []
                for i in feat.index:
                    p = m.probability(feat.loc[i, m.feats].to_numpy(float))
                    vals.append(np.nan if p is None else p)
                probs[h] = np.asarray(vals, float)

        out = []
        for pos, i in enumerate(feat.index):
            p7 = (float(probs[7][pos])
                  if 7 in probs and np.isfinite(probs[7][pos]) else None)
            p30 = (float(probs[30][pos])
                   if 30 in probs and np.isfinite(probs[30][pos]) else None)
            f_lvl = (self.models[30].level(p30) if (p30 is not None and 30 in self.models) else None)
            combined, dual = self.fuse(int(s_lvl.loc[i]), f_lvl)
            data_ok = bool(s_avail.loc[i])
            notes = []
            if not data_ok:
                # 没有有效读数时等级是没有意义的：照旧给 0（维持 0–4 契约），
                # 但必须显式标出来，否则"掉线"会被读成"平静"。
                notes.append("近 24 小时没有可用的位移增量，本行等级未更新（不是『平静』）")
            if mode != "full":
                notes.append("本设备未接入库水位，仅输出当下哨兵级（不做未来预测）")
            elif p30 is None:
                notes.append("库水位缺口或 90 日窗口未就绪，本日不做未来预测（只给哨兵级）")
            if dual:
                notes.append("哨兵与预警双确认，已升一级")
            out.append(Warning(
                ts=str(feat.loc[i, "ts"])[:19], mode=mode,
                p7=(round(p7, 4) if p7 is not None else None),
                p30=(round(p30, 4) if p30 is not None else None),
                sentinel_level=int(s_lvl.loc[i]),
                sentinel_channels=[c for c in str(s_ch.loc[i]).split(",") if c],
                forecast_level=f_lvl, combined_level=combined,
                stage=LEVEL_NAME[combined], advice=LEVEL_ADVICE[combined],
                data_available=data_ok,
                notes=notes,
            ))
        return [w.__dict__ | {"dual_confirmed": self.fuse(w.sentinel_level, w.forecast_level)[1]}
                for w in out]


predictor = WarningPredictor()
