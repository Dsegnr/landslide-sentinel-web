#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""涌浪估算（潘家铮法）自检：脚本式测试，与项目其它测试一致。

用法：python tests/test_wave.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from services.wave import (  # noqa: E402
    G, HELLER_LIMITS, K_REFLECT_MAX, K_REFLECT_MIN, WaveInput, estimate_full,
    estimate_heller, estimate_scenarios, heller_at_opposite, heller_decay,
    heller_applicability, heller_dimensionless, heller_near_field, heller_primary_volume,
    heller_wave_type,
    initial_wave, opposite_wave, series_terms, velocity_from_drop,
    velocity_from_drop_friction, velocity_from_monitoring,
)


def check(name: str, cond: bool, detail: str = "") -> None:
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" :: {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def main() -> int:
    # 1) 落差法速度：v = √(2·g·Δh·k_eff)
    v100 = velocity_from_drop(100.0, 0.5)
    check("落差 100 m、k_eff=0.5 → v≈31.3 m/s", abs(v100 - 31.32) < 0.1, f"v={v100:.2f}")
    check("落差为 0 → v=0", velocity_from_drop(0.0) == 0.0)
    check("k_eff 越大速度越大", velocity_from_drop(100, 0.7) > velocity_from_drop(100, 0.3))

    # 2) 监测位移速率口径
    check("0.5 m / 3600 s → ≈1.39e-4 m/s",
          abs(velocity_from_monitoring(0.5, 3600) - 1.3889e-4) < 1e-8)
    check("时长为 0 → 0", velocity_from_monitoring(1.0, 0) == 0.0)

    # 2b) 外部标定锚点：索风营水电站卞家寨滑坡算例（文献 [2]）
    #     v = 15.12 m/s、当量水深 h = 15.25 m → 初始涌浪（水平项）= 22.06 m
    zx_paper, _, _ = initial_wave(15.12, 15.25, 15.0)
    check("复现文献算例：ζ0x = 22.06 m（容差 0.1）", abs(zx_paper - 22.06) < 0.1,
          f"ζ0x={zx_paper:.2f} m")

    # 3) 初始涌浪：两个运动项都随速度单调增
    zx1, zy1, fr1 = initial_wave(10.0, 20.0, 30.0)
    zx2, zy2, _ = initial_wave(20.0, 20.0, 30.0)
    check("初始涌浪随速度单调增", zx2 > zx1 and zy2 > zy1, f"ζ0x {zx1:.1f}→{zx2:.1f}")
    check("水平项 = 1.17·v·√(h/g)", abs(zx1 - 1.17 * 10 * (20 / G) ** 0.5) < 1e-6)
    check("Froude 数 v/√(gh) 计算正确", abs(fr1 - 10 / (G * 20) ** 0.5) < 1e-9)

    # 4) 级数项数查表：T/Δt∈(1,3]→1、(3,5]→2、(5,7]→3
    # 构造 T/Δt：取 B=100 m、c=50 m/s → Δt=2 s
    check("T/Δt=2 → 1 项", series_terms(4.0, 100.0, 50.0) == 1)
    check("T/Δt=4 → 2 项", series_terms(8.0, 100.0, 50.0) == 2)
    check("T/Δt=6 → 3 项", series_terms(12.0, 100.0, 50.0) == 3)

    # 5) 对岸涌浪：反射系数越大越高；宽度比越大（L/B）越高
    z0 = 20.0
    low = opposite_wave(z0, 500, 700, K_REFLECT_MIN, 20.0, 2)
    high = opposite_wave(z0, 500, 700, K_REFLECT_MAX, 20.0, 2)
    check("反射系数 0.85→0.95 使对岸涌浪升高", high > low, f"{low:.2f} → {high:.2f}")
    check("滑体越宽（L/B 越大）对岸涌浪越高",
          opposite_wave(z0, 800, 700, 0.9, 20.0, 2) > opposite_wave(z0, 200, 700, 0.9, 20.0, 2))

    # 6) 白家包实测参数（面积 0.139 km² × 平均厚度 35 m；剖面：滑带埋深 67–80 m、库水位 175 m、剪出口 90 m）
    inp = WaveInput(
        volume_m3=4.9e6,
        slide_width_m=526.0,        # L：滑体宽（布置图量算）
        water_width_m=566.0,        # B：库面宽（DEM 量算：纬度 30.9833° 处连续水面 566 m）
        water_depth_m=85.0,         # 入水点水深（175 m 库水位 − 90 m 剪出口）——公式定义即为该处水深
        slide_thickness_m=70.0,     # 滑体厚度（剖面 QK2/QK1 滑带埋深 66.9/79.9 m）
        drop_m=170.0,               # 后缘 260 m → 剪出口 90 m
        runout_m=400.0,
        slide_duration_s=30.0,      # 假定快速下滑
        k_reflect=0.90,
        k_eff=0.5,
    )
    out = estimate_scenarios(inp, monitored_speed_mps=0.02)   # 监测口径：约 2 cm/s
    drop_r = out["scenarios"]["drop"]
    mon_r = out["scenarios"]["monitoring"]
    print("\n—— 白家包情景（潘家铮法 × 两个速度口径）——")
    print(f"  落差口径：v={drop_r.velocity_mps:6.2f} m/s   Fr={drop_r.froude:5.2f}"
          f"   ζ0={drop_r.zeta0_m:6.1f} m（水平 {drop_r.zeta0_horizontal_m:.1f} + 垂直 {drop_r.zeta0_vertical_m:.1f}）"
          f"   c={drop_r.celerity_mps:5.1f} m/s   项数 {drop_r.series_terms}   对岸 {drop_r.opposite_max_m:6.1f} m")
    if mon_r:
        print(f"  监测口径：v={mon_r.velocity_mps:6.3f} m/s  Fr={mon_r.froude:5.2f}"
              f"   ζ0={mon_r.zeta0_m:6.3f} m                   项数 {mon_r.series_terms}"
              f"   对岸 {mon_r.opposite_max_m:6.3f} m")
    print(f"  保守区间（含反射系数 {K_REFLECT_MIN}–{K_REFLECT_MAX}）："
          f"{out['summary']['opposite_min_m']} ~ {out['summary']['opposite_max_m']} m"
          f"（取保守值 {out['summary']['advisory_m']} m）")
    check("白家包情景有结果且量级合理", drop_r.opposite_max_m > 0 and drop_r.opposite_max_m < 200,
          f"对岸 {drop_r.opposite_max_m:.1f} m")

    # =====================================================================
    # 7) B 档 · Heller/Fritz 族（厚滑体入深水）
    #    出处：Heller V. (2007) Diss. ETH No. 17531
    #    **回归锚点**：原文 6.5 节 1958 Lituya Bay 原型尺度算例（p.143–146）
    # =====================================================================
    print("\n—— B 档 Heller/Fritz 族 ——")

    # 7a) 外部标定锚点：Lituya Bay 原文 Table 6.12 / 6.13
    #     h=122 m, s=92 m, b=823 m, V=51e6 m³, ρs=1620, α=40°, v=92 m/s
    lit = heller_dimensionless(v=92.0, h=122.0, s=92.0, b=823.0,
                               volume_m3=51e6, rho_s=1620.0, alpha_deg=40.0)
    check("Lituya: F = 2.66（原文）", abs(lit["F"] - 2.66) < 0.02, f"F={lit['F']:.3f}")
    check("Lituya: S = 0.75（原文）", abs(lit["S"] - 0.75) < 0.01, f"S={lit['S']:.3f}")
    check("Lituya: M = 6.74（原文）", abs(lit["M"] - 6.74) < 0.05, f"M={lit['M']:.3f}")
    check("Lituya: β = (6/7)·40° = 34.3°（原文）",
          abs(lit["beta_deg"] - 34.3) < 0.1, f"β={lit['beta_deg']:.2f}°")
    check("Lituya: P = 3.37（原文，容差 0.05）",
          abs(lit["P"] - 3.37) < 0.05, f"P={lit['P']:.3f}")

    aM, HM, TM, xM = heller_near_field(lit["P"], 122.0)
    check("Lituya: a_M = 143 m（原文，容差 3）", abs(aM - 143) < 3.0, f"a_M={aM:.0f} m")
    check("Lituya: x_M = 1232 m（原文，容差 30）", abs(xM - 1232) < 30, f"x_M={xM:.0f} m")
    check("Lituya: H_M = 179 m（原文，容差 4）", abs(HM - 179) < 4.0, f"H_M={HM:.0f} m")
    check("Lituya: T_M = 58 s（原文，容差 1）", abs(TM - 58) < 1.0, f"T_M={TM:.0f} s")
    check("Lituya: V_cP = 53e6 m³（原文，容差 2e6）",
          abs(heller_primary_volume(lit["P"], 823.0, 122.0) - 53e6) < 2e6,
          f"V_cP={heller_primary_volume(lit['P'], 823.0, 122.0):.2e} m³")
    check("Lituya: 波型判为 bore（原文 p.146）",
          heller_wave_type(lit["F"], lit["S"], lit["M"], lit["beta_deg"]) == "bore")

    # 7b) 衰减式原文自检：A(X=1)=0.5 → A(10)=0.27（−46%）→ A(100)=0.15（−70%）
    #     即比例 10^(-4/15)=0.541、100^(-4/15)=0.293
    r10 = 10.0 ** (-4.0 / 15.0)
    r100 = 100.0 ** (-4.0 / 15.0)
    check("衰减指数 X^(-4/15)：0.5→0.27", abs(0.5 * r10 - 0.27) < 0.005, f"{0.5 * r10:.3f}")
    check("衰减指数 X^(-4/15)：0.5→0.15", abs(0.5 * r100 - 0.15) < 0.005, f"{0.5 * r100:.3f}")
    check("衰减式在 X<10 时不可用（返回 None）",
          heller_decay(lit["P"], 122.0, 5.0 * 122.0) is None)
    check("衰减式在 X=50 时可用",
          heller_decay(lit["P"], 122.0, 50.0 * 122.0) is not None)

    # 7c) 式 6.1 滑速口径
    v90 = velocity_from_drop_friction(100.0, 90.0, 14.0)
    check("式 6.1：α=90° 退化为自由落体 √(2gΔz)",
          abs(v90 - (2 * G * 100) ** 0.5) < 1e-6, f"v={v90:.2f}")
    check("式 6.1：α 越小滑速越低",
          velocity_from_drop_friction(100, 30) < velocity_from_drop_friction(100, 60))
    check("式 6.1：α ≤ δ 时返回 0（无法加速）",
          velocity_from_drop_friction(100, 10, 14) == 0.0)
    check("式 6.1：落差 0 → 0", velocity_from_drop_friction(0.0, 40.0) == 0.0)

    # 7d) 单调性：P 越大波越高（两档一致）
    lo = heller_near_field(1.0, 50.0)[0]
    hi = heller_near_field(4.0, 50.0)[0]
    check("Heller：P 越大 a_M 越大", hi > lo, f"a_M {lo:.1f} → {hi:.1f}")

    # 7e) 落差口径（2026-09-16 修正）：Δz_sc 是**质心到静水面**，不是滑面总高差
    #
    #     Heller 原文 Figure 6.8：609 m 量到 **0 m 水位线**，不是 −122 m 河床；
    #     p.74：V_s 就是入水那一瞬的速度。所以它与潘家铮档的 drop_m 不是同一个量。
    d_li = heller_dimensionless(v=5.0, h=85.0, s=70.0, b=526.0,
                                volume_m3=4.9e6, rho_s=1800.0, alpha_deg=40.0)
    check("白家包：S = 0.824 落在标定域内（限值 1.64）",
          HELLER_LIMITS["S"][0] <= d_li["S"] <= HELLER_LIMITS["S"][1], f"S={d_li['S']:.3f}")

    # 没给质心/水面高程 → 判不了前提，同样不出数
    _, r_missing = heller_applicability(inp)
    check("白家包：未给质心/水面高程时拒绝出数", "未提供" in r_missing, r_missing[:40])

    # 剖面实量：质心 151 m、蓄水位 175 m → Δz_sc = −24 m（质心已没入水面）
    bj_inp = WaveInput(
        volume_m3=4.9e6, slide_width_m=526.0, water_width_m=566.0, water_depth_m=85.0,
        slide_thickness_m=70.0, drop_m=160.0, runout_m=400.0, slide_duration_s=30.0,
        centroid_elev_m=151.0, water_level_m=175.0,
    )
    check("白家包 Δz_sc = 151 − 175 = −24 m", abs(bj_inp.centroid_drop_m + 24.0) < 1e-9,
          f"Δz_sc={bj_inp.centroid_drop_m:.1f} m")
    ok_bj, why_bj = heller_applicability(bj_inp)
    check("白家包：B 档判为**不适用**（滑体已没入水面）", not ok_bj and "没入水面" in why_bj,
          why_bj)
    hr_bj = estimate_heller(bj_inp)
    check("白家包：不适用时**一个数都不出**（近场量全部为 0）",
          not hr_bj.applicable and hr_bj.amplitude_max_m == 0.0
          and hr_bj.p_impulse == 0.0 and hr_bj.violations == (),
          f"applicable={hr_bj.applicable} a_M={hr_bj.amplitude_max_m}")

    # 对照：Lituya 算例的 Δz_sc = 609 m > 0 → 前提成立，可正常算
    li_inp = WaveInput(
        volume_m3=51e6, slide_width_m=823.0, water_width_m=823.0, water_depth_m=122.0,
        slide_thickness_m=92.0, drop_m=609.0, runout_m=1000.0, slide_duration_s=30.0,
        rho_s_kgm3=1620.0, alpha_deg=40.0, delta_deg=14.0,
        centroid_elev_m=609.0, water_level_m=0.0,
    )
    ok_li, _ = heller_applicability(li_inp)
    hr_li = estimate_heller(li_inp)
    check("Lituya：Δz_sc = 609 m > 0 → 前提成立，且式 6.1 复现原文 v = 92 m/s",
          ok_li and hr_li.applicable and abs(hr_li.velocity_mps - 92) < 1.0,
          f"v={hr_li.velocity_mps:.1f} m/s")
    check("Lituya：a_M 复现原文 143 m（容差 3）",
          abs(hr_li.amplitude_max_m - 143) < 3, f"a_M={hr_li.amplitude_max_m:.0f} m")

    # 前提成立但滑速不足时，仍然只是"外推"而不是"不适用"——两种状态要分清
    slow = WaveInput(
        volume_m3=4.9e6, slide_width_m=526.0, water_width_m=566.0, water_depth_m=85.0,
        slide_thickness_m=70.0, drop_m=160.0, runout_m=400.0, slide_duration_s=30.0,
        centroid_elev_m=175.0, water_level_m=145.0,      # Δz_sc = 30 m，前提成立
    )
    hr_slow = estimate_heller(slow)
    check("前提成立但 F 不足 → 标'外推'而不是'不适用'",
          hr_slow.applicable and "F" in hr_slow.violations,
          f"applicable={hr_slow.applicable} F={hr_slow.froude:.3f} 越界={hr_slow.violations}")

    # 7f) 两档并列：各用自己口径的速度
    full = estimate_full(bj_inp, monitored_speed_mps=0.02)
    print("\n—— 白家包：两档并列（各按原文口径）——")
    for row in full["rows"]:
        hh, pp = row["heller"], row["panjiazheng"]
        if hh["applicable"]:
            flag = "域内" if hh["in_domain"] else "外推:" + ",".join(hh["violations"])
            htxt = (f"Heller v={hh['velocity_mps']:6.2f} a_M={hh['amplitude_max_m']:6.1f} m [{flag}]")
        else:
            htxt = f"Heller **不适用**：{hh['unavailable_reason'][:34]}"
        print(f"  {row['label']:<22} 潘家铮 v={pp['velocity_mps']:6.2f} "
              f"对岸={pp['opposite_min_m']:6.1f}~{pp['opposite_max_m']:6.1f} m | {htxt}")
    check("estimate_full 给出两个情景", len(full["rows"]) == 2, f"{len(full['rows'])} 行")
    check("白家包：heller 行里没有数值字段（不适用就不出数）",
          all("P" not in r["heller"] and "amplitude_max_m" not in r["heller"]
              for r in full["rows"]))
    check("白家包：潘家铮档照常给数", all(r["panjiazheng"]["opposite_max_m"] > 0
                                        for r in full["rows"]))
    # 审计修正：潘家铮档不宣称"超域"，只如实标 caveat（无公开适用域 + 速度口径为简化式）
    cav = full["rows"][0]["panjiazheng"]["caveat"]
    check("潘家铮档如实标 caveat（无公开适用域 + 非条分法速度）",
          "无公开适用域" in cav and "条分法" in cav, cav[:40] + "…")
    check("Lituya 并列时 Heller 可用且对岸兜底标记正确",
          all("at_opposite_uses_decay" in r["heller"] for r in estimate_full(li_inp)["rows"]))
    # 7g) 告警口径：只有「前提成立 + 域内」的档才有资格进告警
    adv_bj = full["advisory"]
    check("白家包：B 档前提不成立 → 不给告警等级",
          adv_bj["status"] == "not_applicable" and adv_bj["level"] is None
          and adv_bj["usable_m"] is None, adv_bj["reason"][:30])
    adv_li = estimate_full(li_inp)["advisory"]
    check("Lituya：有域内档 → 出等级，且注明取值来源",
          adv_li["status"] == "ok" and adv_li["level"] == 4
          and "Heller" in adv_li["basis"], f"level={adv_li['level']} basis={adv_li['basis']}")
    adv_slow = estimate_full(slow)["advisory"]
    check("只有外推档时也不给等级（不拿无依据的数当告警）",
          adv_slow["status"] == "extrapolated_only" and adv_slow["level"] is None,
          adv_slow["status"])
    check("告警阈值标注为项目工作口径（无文献依据）",
          "无文献依据" in adv_li["thresholds_source"])

    print("\n全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
