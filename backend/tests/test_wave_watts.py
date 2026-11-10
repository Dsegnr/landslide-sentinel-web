"""C 档 · Watts (2000) 能量路线自检。

回归锚点用**论文自己的实验**（Table 1/2 的 2n 块体，θ=45°，d=75 mm）：
原文实测 u_t = 0.56 ± 0.017 m/s、正文 t_o ≈ 0.35 s、Fig.5 远场波幅 2–8 mm。

运行：cd web/backend && python tests/test_wave_watts.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from services.wave import (  # noqa: E402
    WattsInput, estimate_watts, watts_added_mass, watts_block_motion,
)


def check(name: str, cond: bool, detail: str = "") -> None:
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" :: {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def main() -> int:
    # 论文 Table 1 的 2n 块体：b=8.50 cm、m_b=0.6723 kg、ρ_b=1870 kg/m³、w=9.90 cm
    B, RHO_B, THETA, D, H = 0.0850, 1870.0, 45.0, 0.075, 0.373

    # Eq (5) 附加质量：原文 Fig.2 在 d/b≈0.88 处约 0.88–0.9
    cm = watts_added_mass(D / B)
    check("Eq(5) 附加质量系数 C_m(d/b=0.88) ≈ 0.88", abs(cm - 0.88) < 0.05, f"C_m={cm:.3f}")

    inp = WattsInput(block_size_m=B, submergence_m=D, rho_b=RHO_B,
                     theta_deg=THETA, water_depth_m=H)
    m = watts_block_motion(inp)
    check("Eq(2) 终速复现论文实测 0.56 m/s（±5%）",
          abs(m["u_t"] - 0.56) / 0.56 < 0.05, f"u_t={m['u_t']:.3f} m/s")
    check("Eq(4b) 特征时间复现正文 t_o ≈ 0.35 s（±15%）",
          abs(m["t_o"] - 0.35) / 0.35 < 0.15, f"t_o={m['t_o']:.3f} s")

    out = estimate_watts(inp)
    check("C 档前提成立", out["applicable"], out["unavailable_reason"])
    # Fig.5 远场波幅 2–8 mm；近场 η_max 应与之同量级或更大
    check("η_max（ε=3–7%）落在原文实测波幅量级内（2–20 mm）",
          0.002 <= out["amplitude_min_m"] <= out["amplitude_max_m_hi"] <= 0.020,
          f"η_max = {out['amplitude_min_m']*1000:.2f}–{out['amplitude_max_m_hi']*1000:.2f} mm")
    check("深/浅水判据：h > t_o·√(g·d) 判为深水",
          out["deepwater"] is True, f"限值 {out['deepwater_limit_m']:.3f} m，实际 h={H} m")
    check("映射口径必须显式交代（天然滑坡→方块是假设）",
          "理想化" in out["idealization"] or "方块" in out["idealization"])

    # 坡角不足以克服摩擦时不硬算
    # 摩擦角 ≈17.5°（C_n=tanφ），取 10° 明确不足
    flat = WattsInput(block_size_m=B, submergence_m=D, rho_b=RHO_B,
                      theta_deg=10.0, water_depth_m=H)
    bad = estimate_watts(flat)
    check("θ ≤ 摩擦角时不硬出数，如实判不适用",
          bad["applicable"] is False and "摩擦" in bad["unavailable_reason"],
          bad["unavailable_reason"])

    print("\nC 档 Watts 能量路线自检通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
