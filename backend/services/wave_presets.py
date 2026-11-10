"""涌浪点位预设表（与设备绑定）。放 service 层：轮询与路由都要用，
路由导入服务而不是反过来。"""
from __future__ import annotations

from services.wave import DELTA_DEFAULT

PRESETS: dict[str, dict] = {
    "baijiabao": {
        "name": "白家包（湖北 秭归 · 三峡库区）",
        "note": "剖面 I-I′ 实量：滑体质心 151 m、蓄水位 175 m（汛期消落 145 m）",
        "volume_m3": 4.9e6,
        "slide_width_m": 526.0,      # 沿河宽度（布置图量算）
        "water_width_m": 566.0,      # 库面宽（DEM 量算，纬度 30.9833° 处连续水面）
        "water_depth_m": 85.0,       # 入水点水深 = 175 m 库水位 − 90 m 剪出口
        "slide_thickness_m": 70.0,   # 剖面 QK2/QK1 滑带埋深 66.9/79.9 m
        # 潘家铮档用：**滑面总高差**（后缘 258 m − 剪出口 98 m，剖面 I-I′ 量算）
        "drop_m": 160.0,
        "runout_m": 400.0,
        "slide_duration_s": 30.0,
        "rho_s_kgm3": 1800.0,
        "alpha_deg": 40.0,
        "delta_deg": DELTA_DEFAULT,
        "k_reflect": 0.90,
        "k_eff": 0.5,
        # Heller 档用：质心释放高程 / 静水面高程。
        # 154 m 由 `_tools/digitize_baijiabao_profile.py` 对剖面程序化提取后面积加权得到
        # （人工读图给 151 m，两者差 3 m，互为交叉验证）。
        # 154 − 175 = **−21 m** → 质心已没入水面，B 档前提不成立，自动判"不适用"、不出数。
        "centroid_elev_m": 154.0,
        "water_level_m": 175.0,
        # C 档（Watts 方块）的映射口径 —— **这是我们定的，不是现场观测量**：
        #   b：面积等效 √(2A)，A=40,212 m²（剖面数字化量出）→ 283.6 m
        #   d：滑体质心相对静水面的淹没深度 175−154 = 21 m
        #   θ：滑面首末弦倾角 (258−98)/611 → 14.7°
        # 按这套口径算出来是"刚块不启动"（14.7° < 摩擦角 17.5°），
        # 与"白家包是骑水线的天然滑体、滑面很缓"这一事实一致。
        "watts_block_size_m": 283.6,
        "watts_submergence_m": 21.0,
        "watts_theta_deg": 14.7,
        "unconfirmed": ["alpha_deg", "rho_s_kgm3", "centroid_elev_m"],
    },
    # Heller 档**唯一有原文背书的原型尺度案例**（论文 6.5 节），用来演示这一档本身。
    # 复现结果见 tests/test_wave.py：与原文 Table 6.13 误差 <1%。
    "lituya": {
        "name": "Lituya Bay 1958（Heller 2007 原型算例）",
        "note": "论文 6.5 节算例：质心落差 609 m · 水深 122 m · 滑体厚 92 m —— B 档演示",
        "volume_m3": 51e6,
        "slide_width_m": 823.0,
        "water_width_m": 823.0,
        "water_depth_m": 122.0,
        "slide_thickness_m": 92.0,
        "drop_m": 609.0,
        "runout_m": 1000.0,
        "slide_duration_s": 30.0,
        "rho_s_kgm3": 1620.0,
        "alpha_deg": 40.0,
        "delta_deg": 14.0,
        "k_reflect": 0.90,
        "k_eff": 0.5,
        "centroid_elev_m": 609.0,
        "water_level_m": 0.0,        # 以水面为高程基准（原文 Figure 6.8）
        "unconfirmed": [],
    },
}


def binding_map(raw: str) -> dict[str, str]:
    """解析 WAVE_BINDINGS（device_id:site,device_id:site）。"""
    out: dict[str, str] = {}
    for part in (raw or "").split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        dev, site = part.split(":", 1)
        dev, site = dev.strip(), site.strip()
        if dev and site in PRESETS:
            out[dev] = site
    return out
