"""滑坡涌浪估算：两档方法并列（潘家铮法 + Heller/Fritz 族）。

为什么有这一层：现有模型只回答"会不会滑、概率多大"，但库区滑坡真正的后果是**涌浪**——
冲击对岸、威胁航运与码头。这一层把"滑体入水"换算成"涌浪高度"。

两档方法各有适用域，**必须并列展示、各自标注是否越界**（详见第七节与
`docs/涌浪模型_公式核对_Heller2007.md`）：

  A 档 · 潘家铮法（本文件第一段）：初始涌浪 ζ0/h = 1.17·v/√(g·h)，**对 v 线性、无内建上限**；
      滑速本应由**条分法**（φ、C、F_os、条块几何）沿滑面积分给出，本文件暂用简化能量式
      + k_eff（经验值，见下"速度口径"一节），**这是我们的简化，不是文献口径**。
      **该式没有公开的适用域**：文献 [1][2] 都没给；我们能对照的只有一个算例
      （索风营，t/h≈0.98、h=15.25 m、v=15.12 m/s → ζ0x=22.06 m，已写成断言）。
      所以对白家包**不宣称"超域"**——只如实标"本档无公开适用域 + 速度口径为简化式"。
      （2026-09-16 审计：此前代码与文档里"潘家铮法适用薄滑体""白家包超出其适用区间"
      "量级失控"三句**均无出处**，且与索风营算例矛盾，已删除。）
  B 档 · Heller/Fritz 族：自变量是冲量积参数 P = F·S^(1/2)·M^(1/4)·(cosβ)^(1/2)，
      其中 F=v/√(gh)、S=s/h、M=m_s/(ρ_w·b·h²)、β=(6/7)α。
      **专为厚滑体入深水设计**（原文标定域 S 到 1.64）。

公式与出处（逐条核对过原文，不是凭记忆写的）：
  [1] 潘家铮《建筑物的抗滑稳定和滑坡分析》（1980）——条分法滑速、初始涌浪、涌浪传播级数解
  [2] 《基于潘家铮法的滑坡涌浪参数敏感性分析》，中国农村水利水电 2023，
      DOI 10.12396/znsd.221729 —— 逐条复述了 [1] 的公式（本文件按该文形式实现）
  [3] Heller V. (2007) *Landslide generated impulse waves: Prediction of near field
      characteristics*, Diss. ETH No. 17531 —— B 档全部公式与适用域（Table 5.1）来源；
      第 6.5 节给出 1958 Lituya Bay 原型尺度算例，已作为回归锚点写进测试

实现的是其中可直接计算的部分：
  * 初始涌浪（水平运动项）  ζ0x/h = 1.17·v_x/√(g·h)          （h = 当量水深）
  * 初始涌浪（垂直运动项）  ζ0y/h = f(v/√(g·h))              （h = **滑坡厚度**）
        f = 1.0           当 v/√(gh) < 0.5
        f 查图 3-18       当 0.5 ≤ v/√(gh) ≤ 2.0（本实现按端点线性内插近似）
        f = 1.0           当 v/√(gh) > 2.0
  * 对岸最大涌浪            ζ_Amax = (2ζ0/π)(1+k)·Σ_{n=1,3,5}^{N} k^{2(n−1)}
                                      ·ln{ L/((2n−1)B) + √(1+(L/((2n−1)B))²) }
        L = 滑坡体宽度，B = 涌浪传播的水面宽度，k = 岸壁反射系数（实际 0.85–0.95）
        级数项数 N 按滑坡历时 T 与涌浪跨河时间 Δt = B/c 查表：T/Δt∈(1,3]→1、(3,5]→2、(5,7]→3…
  * 涌浪传播速度            c = √(g·h)·√(1 + 1.5·ζ0/h + 0.5·ζ0²/h²)

B 档（Heller/Fritz 族，原文式号）：
  * 冲量积参数      P = F·S^(1/2)·M^(1/4)·(cosβ)^(1/2)            (5.2)
  * 最大波幅        a_M = (4/9)·P^(4/5)·h                          (5.3)
  * 最大波高        H_M = (5/9)·P^(4/5)·h = (5/4)·a_M              (5.5)
  * 波周期          T_M = 9·P^(1/2)·(h/g)^(1/2)                    (5.6)
  * 最大波幅位置    x_M = (11/2)·P^(1/2)·h                         (5.4)
  * 首波体积        V_cP = P^(6/5)·b·h²                            (5.8)
  * 波幅衰减        a(x) = (3/5)·[P·X^(-1/3)]^(4/5)·h, 10 ≤ X ≤ 59  (5.20)
  * 波型判别        S^(1/3)·M·cosβ 与 (4/5)F^(-7/5)、11·F^(-5/2) 比较 (5.25–5.27)
  * 入水速度        V_s = [2·g·Δz_sc·(1 − tanδ·cotα)]^(1/2)        (6.1)

B 档标定域（原文 Table 5.1，434 次试验）：30° ≤ α ≤ 90°、0.86 ≤ F ≤ 6.83、
0.09 ≤ S ≤ 1.64、0.11 ≤ M ≤ 10.02、X ≤ 59、0.17 ≤ P ≤ 8.13。
**越界必须显式报出**（`violations`），不得与域内结果同等呈现。

速度 v 的两个口径（队长要求都保留）——**文献口径 + 我们的扩展，分开标注**：

  A. 几何/力学口径（文献口径）：文献里滑速**不是**由监测数据来的，而是由
     *条分法* 逐条块做力平衡后积分得到（潘家铮法：v_{i+1}=√(v_i²+2a_xΔL)，
     a_x 由重力分量、摩擦力 tanφ、黏聚力 C 与强度折减系数 F_os 共同决定）；
     工程简化可用摩擦限速的能量式 v = √(2·g·Δh·(1−f·L/Δh))，f 为动摩擦系数。
     本文件先用**简化能量式 + k_eff**（默认 0.5）给出上界，标注为"简化"，
     待条分法参数（φ、C、F_os、条块几何）到位后替换。

  B. 监测口径（**我们的扩展，文献没有**）：文献里 GNSS/裂缝位移只用于
     识别滑体、判定活动性与阶段，**不作为入水速度输入**。我们的定义（待队长确认）：
       M1 当前状态：v_now = ds/dt（滑动平均）、a_now = dv/dt；用 1/v–t（Saito 倒速度法）
          外推失稳时间区间；
       M2 入水速度上界：v_impact ≈ v_now + a_now·t_remaining（t_remaining 由 M1 给），
          再与几何口径的 v_geom 取**包络（较大者）**作为保守输入。
     数据基础：白家包日尺度 GNSS（8 年，标定 M1/M2）、马家沟小时级（交叉验证）、
     自采原型机分钟级（现场实时跑 M1）。M2 是外推，不是实测，页面上必须写明。

边界（页面与文档必须同时写明）：
  * 经验/解析公式，**不是数值模拟**；对参数（k、k_eff、h、L、B）敏感；
  * Δt 用恒定波速 c 估算，未考虑河道弯曲与浅水变形；
  * 不能作为避险决策依据。
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

G = 9.81

# 能量转化系数默认值（简化能量法；仅作情景 A 用）
K_EFF_DEFAULT = 0.5
# 岸壁反射系数：理想直立光滑不透水岸壁 = 1.00；工程实际取 0.85–0.95（文献 [2] 原文）
K_REFLECT_MIN, K_REFLECT_MAX = 0.85, 0.95

# ==== B 档（Heller/Fritz 族）常量 ====
RHO_W = 1000.0                 # 水的密度 kg/m³（原文 M 的分母）
RHO_S_DEFAULT = 1800.0         # 滑体容重默认值（黄土—岩土混合，待现场取样确认）
ALPHA_DEFAULT = 40.0           # 滑体入水冲击角默认值（坡角，待剖面确认）
DELTA_DEFAULT = 14.0           # 动床摩擦角默认值（原文 Lituya 用 Slingerland & Voight 1979 的 14°）

# 原文 Table 5.1（全部 434 次试验）的标定域，越界即外推
HELLER_LIMITS: dict[str, tuple[float, float]] = {
    "F": (0.86, 6.83),
    "S": (0.09, 1.64),
    "M": (0.11, 10.02),
    "P": (0.17, 8.13),
}
# 衰减式 Eq. 5.20 的独立有效区（X→0 时 a→∞，故冲击区内不可用）
HELLER_X_DECAY_MIN, HELLER_X_DECAY_MAX = 10.0, 59.0

# B 档波型名 → 中文（原文 5.25–5.27 三类）
WAVE_TYPE_CN = {
    "stokes": "Stokes 型（振荡波）",
    "cnoidal_solitary": "cnoidal / 孤立波型",
    "bore": "涌潮型（bore）",
}

# ==== 涌浪告警口径（2026-09-16 定稿）====
# 阈值单位：米。**这是本项目的工作口径，没有文献依据** —— 引用时必须同时给出这句话。
# 分档含义：2 m 明显可感 / 5 m 威胁中小船舶与码头作业 / 10 m 冲击码头与岸上设施 /
#          20 m 灾难级（Lituya Bay 1958 为 143 m 量级）。
# 定稿前需与现场保护对象（码头高程、航道、岸上设施）核定。
WAVE_ALERT_THRESHOLDS_M = (2.0, 5.0, 10.0, 20.0)
WAVE_THRESHOLD_SOURCE = ("项目工作阈值，无文献依据；需与现场保护对象（码头/航道/岸上设施）核定")


# ==== C 档 · Watts (2000) 水下/部分淹没滑坡的能量路线 ====
# 出处：Watts, P. (2000). "Tsunami features of solid block underwater landslides."
#       J. Waterway, Port, Coastal, Ocean Eng. 126(3): 144–152.
# 图版：docs/文献图版/Watts2000/（p.144 的 Eq 1/2、p.145 的 Eq 3/4/5、p.147 的 Eq 9–14、
#       p.150 的 Eq 23/24 均已逐条核对）
#
# 为什么要这一档：Heller 的 subaerial 框架要求滑体从水面**之上**入水；白家包滑体质心
# 在水面之下，前提不成立。Watts 这套正是为**没入水中的块体**建立的，所以补上它。
#
# **本档算的是理想化刚性方块**（直角三角形、从静止释放、沿斜面下滑）。
# 把天然滑坡映射到方块上是有假设的，映射口径必须单独交代，不能默认。
WATTS_BIB = ("Watts P. (2000) Tsunami features of solid block underwater landslides, "
             "JWPCOE 126(3):144-152")
WATTS_EPSILON_RANGE = (0.03, 0.07)   # 能量转化效率 ε（Eq 24 + Fig 8 实测区间）
WATTS_C_N = 0.32                     # 库仑摩擦系数 = tan(17.5°)，原文 p.145
WATTS_C_D = 1.70                     # 拖曳系数，原文 p.145


@dataclass(frozen=True)
class WattsInput:
    """C 档输入。**注意 `block_size_m` 与 Heller 档的 b（滑体宽度）不是一个量。**"""
    block_size_m: float      # b：块体边长（沿坡方向的尺度）
    submergence_m: float     # d：初始淹没深度（块体顶面到静水面的距离）
    rho_b: float             # 块体容重
    theta_deg: float         # 坡角
    water_depth_m: float     # h：远端河道水深（用于深/浅水判据）


def watts_added_mass(d_over_b: float) -> float:
    """Eq (5)：附加质量系数 C_m(d/b; θ=45°, t=0⁺) 的三次拟合。"""
    x = max(0.0, d_over_b)
    return 0.415 + 1.457 * x - 1.339 * x ** 2 + 0.325 * x ** 3


def watts_block_motion(inp: WattsInput, rho_o: float = RHO_W,
                       c_n: float = WATTS_C_N, c_d: float = WATTS_C_D) -> dict:
    """Eq (1)(2)(4)：初始加速度 a_o、终速 u_t、特征时间 t_o、特征距离 s_o。

    单位宽度量：块体截面积 `A = b²/2`（直角三角形），单位宽度质量 `m_b' = ρ_b·A`。
    原文 Eq (1)(2) 用的是**总质量**，但两式的分子分母同阶，换成单位宽度量等价。
    """
    b, d = inp.block_size_m, inp.submergence_m
    th = math.radians(inp.theta_deg)
    m_b = inp.rho_b * (b * b / 2.0)                    # 单位宽度质量
    m_o = rho_o * (b * b / 2.0)                        # 同体积水的质量
    c_m = watts_added_mass(d / b if b > 0 else 0.0)
    drive = math.sin(th) - c_n * math.cos(th)
    if drive <= 0 or b <= 0:
        return {"a_o": 0.0, "u_t": 0.0, "t_o": 0.0, "s_o": 0.0, "c_m": c_m,
                "usable": False, "reason": "坡角不足以克服库仑摩擦，块体不会启动"}
    a_o = (m_b - m_o) * G * drive / (m_b + c_m * m_o)              # Eq (1)
    # Eq (2)：原文分母是 C_d·ρ_o·w·b·sinθ，w 为块体宽度；取单位宽度后 w→1
    u_t = math.sqrt(2.0 * (m_b - m_o) * G * drive / (c_d * rho_o * b * math.sin(th)))
    if u_t <= 0 or a_o <= 0:
        return {"a_o": a_o, "u_t": u_t, "t_o": 0.0, "s_o": 0.0, "c_m": c_m,
                "usable": False, "reason": "终速/初加速度非正，块体运动方程不适用"}
    return {"a_o": a_o, "u_t": u_t, "t_o": u_t / a_o, "s_o": u_t ** 2 / a_o,
            "c_m": c_m, "usable": True, "reason": ""}               # Eq (4a,b)


def watts_energy_amplitude(motion: dict, inp: WattsInput, epsilon: float,
                           rho_o: float = RHO_W) -> float:
    """Eq (23)+(24) 联立反解最大近场波幅：

        E = ½·ρ·g·η_max²·λ_o          (23)
        ε = E / (½·m_b'·u_t²)          (24)
        λ_o = t_o·√(g·d)               （特征近场波长）
        ⇒ η_max = √( ε·m_b'·u_t² / (ρ·g·λ_o) )
    """
    b, d, th = inp.block_size_m, inp.submergence_m, inp.theta_deg
    m_b = inp.rho_b * (b * b / 2.0)
    lam_o = motion["t_o"] * math.sqrt(G * max(d, 1e-9))
    if lam_o <= 0:
        return 0.0
    return math.sqrt(epsilon * m_b * motion["u_t"] ** 2 / (rho_o * G * lam_o))


def estimate_watts(inp: WattsInput) -> dict:
    """C 档完整结果：运动量 + 三档 ε 下的 η_max + 远近场与深/浅水判据。"""
    motion = watts_block_motion(inp)
    if not motion["usable"]:
        return {"applicable": False, "unavailable_reason": motion["reason"],
                "motion": motion, "bib": WATTS_BIB}
    lo, hi = WATTS_EPSILON_RANGE
    amp = {f"eps_{int(e*100)}": watts_energy_amplitude(motion, inp, e)
           for e in (lo, (lo + hi) / 2.0, hi)}
    # Eq (14)：h > t_o·√(g·d) 时为深水波；否则浅水
    deep_limit = motion["t_o"] * math.sqrt(G * max(inp.submergence_m, 1e-9))
    return {
        "applicable": True, "unavailable_reason": "",
        "motion": motion,
        "amplitude_max_m": amp["eps_5"],          # 中值 5% 作代表值
        "amplitude_min_m": amp["eps_3"],
        "amplitude_max_m_hi": amp["eps_7"],
        "epsilon_range": list(WATTS_EPSILON_RANGE),
        "lambda_o_m": motion["t_o"] * math.sqrt(G * max(inp.submergence_m, 1e-9)),
        "deepwater": inp.water_depth_m > deep_limit,
        "deepwater_limit_m": deep_limit,
        "bib": WATTS_BIB,
        # 映射口径必须显式交代：天然滑坡 → 理想化方块是有假设的
        "idealization": ("本档算的是刚性方块（直角三角形、静止释放、沿斜面下滑）。"
                         "把天然滑坡映射到方块需要单独定 b/d/θ 的口径，"
                         "该映射尚未与现场几何核定。"),
    }


def wave_advisory(rows: list[dict]) -> dict:
    """把两档结果汇总成一条**"能出结论才出数"**的告警口径。

    规则只有一条，但它决定了整套东西能不能站得住：

      **只有「前提成立 且 落在原文标定域内」的档才有资格进告警。**

    * 有资格 → `status="ok"`，取其中**最保守**（最大）的值分档，给出 0–4 级；
    * 只有"前提成立但超标定域"的档 → `status="extrapolated_only"`，**不给等级**；
    * 全部前提不成立 → `status="not_applicable"`，**不给等级**。

    **潘家铮档永远不进告警**：它没有公开适用域（见 `docs/涌浪模型_公式核对_Heller2007.md`
    的审计记录），把一个无从判定的数接进告警，等于给系统装了个假警报器。
    它照常展示，只是不参与判定。
    """
    qualified: list[tuple[float, str]] = []      # 有资格：前提成立 + 域内
    extrapolated: list[tuple[float, str]] = []   # 前提成立但超域
    for r in rows:
        h = r.get("heller") or {}
        if not h.get("applicable"):
            continue
        item = (float(h["amplitude_max_m"]), f"Heller·{r['label']}")
        (qualified if h.get("in_domain") else extrapolated).append(item)

    if qualified:
        value, basis = max(qualified)
        level = bisect.bisect_right(WAVE_ALERT_THRESHOLDS_M, value)   # 0–4
        return {
            "status": "ok",
            "usable_m": round(value, 2),
            "level": level,
            "basis": basis,
            "reason": "至少有一档前提成立且落在原文标定域内，可作为告警输入",
            "thresholds_m": list(WAVE_ALERT_THRESHOLDS_M),
            "thresholds_source": WAVE_THRESHOLD_SOURCE,
        }

    if extrapolated:
        return {
            "status": "extrapolated_only",
            "usable_m": None, "level": None, "basis": "",
            "reason": ("所有成立的档都超出了原文标定域，只作外推参考，"
                       "不接入告警"),
            "thresholds_m": list(WAVE_ALERT_THRESHOLDS_M),
            "thresholds_source": WAVE_THRESHOLD_SOURCE,
        }

    reason = (rows[0]["heller"].get("unavailable_reason") if rows else "") or "无可用情景"
    return {
        "status": "not_applicable",
        "usable_m": None, "level": None, "basis": "",
        "reason": f"无法给出涌浪结论：{reason}",
        "thresholds_m": list(WAVE_ALERT_THRESHOLDS_M),
        "thresholds_source": WAVE_THRESHOLD_SOURCE,
    }


@dataclass(frozen=True)
class WaveInput:
    """滑体几何与水体参数（单位：m / m³ / m·s⁻¹）。"""
    volume_m3: float          # 滑体体积
    slide_width_m: float      # L：滑坡体宽度（沿河方向）
    water_width_m: float      # B：涌浪传播的水面宽度（跨河）
    water_depth_m: float      # 当量水深（初始涌浪水平项用）
    slide_thickness_m: float  # 滑体厚度（初始涌浪垂直项用！不是水深）
    drop_m: float             # 滑体落差（能量法估算速度用）
    runout_m: float           # 滑体水平运动距离
    slide_duration_s: float   # 滑坡历时 T（决定级数项数）
    k_reflect: float = 0.90   # 岸壁反射系数
    k_eff: float = K_EFF_DEFAULT
    rho_s_kgm3: float = RHO_S_DEFAULT   # 滑体容重（B 档 M = m_s/(ρ_w·b·h²) 用）
    alpha_deg: float = ALPHA_DEFAULT    # 滑体入水冲击角（B 档 β =(6/7)α 用）
    delta_deg: float = DELTA_DEFAULT    # 动床摩擦角（B 档式 6.1 用）
    # B 档（Heller）的落差口径与潘家铮档**不是同一个量**，必须分开给：
    #   drop_m          = 滑面总高差（后缘 → 剪出口），潘家铮能量式用；
    #   centroid_drop_m = 滑体质心释放高程 − 静水面高程，Heller 式 6.1 用。
    # Heller 原文 Figure 6.8：Δz_sc 从质心高程 609 m 量到 **0 m 水位线**（不是 −122 m 河床），
    # 它算的是**入水那一瞬**的速度。把水下段也算进来（用 drop_m）是口径错误。
    # 用 None 表示"没提供"，与合法的 0 m 高程（例如以水面为基准的算例）区分开
    centroid_elev_m: float | None = None   # 滑体质心释放高程（B 档 Δz_sc 上限）
    water_level_m: float | None = None     # 静水面高程（B 档 Δz_sc 下限）
    # C 档（Watts 方块）的三个输入。**这三个是"把天然滑坡映射到理想化方块"的结果**，
    # 不是现场直接观测量，所以单独命名、单独交代口径；不给则 C 档不参与。
    watts_block_size_m: float | None = None       # b：等效块体边长
    watts_submergence_m: float | None = None      # d：初始淹没深度
    watts_theta_deg: float | None = None          # θ：滑动面倾角

    @property
    def centroid_drop_m(self) -> float:
        """Δz_sc = 滑体质心释放高程 − 静水面高程（可为负 = 质心已没入水面）。"""
        if self.centroid_elev_m is None or self.water_level_m is None:
            return 0.0
        return self.centroid_elev_m - self.water_level_m


@dataclass(frozen=True)
class WaveResult:
    velocity_mps: float
    velocity_source: str      # "drop" | "monitoring"
    zeta0_horizontal_m: float
    zeta0_vertical_m: float
    zeta0_m: float            # 初始涌浪高度（两项取和）
    opposite_max_m: float     # 对岸最大涌浪高度
    series_terms: int         # 级数项数
    celerity_mps: float       # 波速
    froude: float             # v/√(g·h)，用于判断适用区间


def velocity_from_drop(drop_m: float, k_eff: float = K_EFF_DEFAULT) -> float:
    """情景 A：落差/能量线估算（v = √(2·g·Δh·k_eff)）。"""
    if drop_m <= 0:
        return 0.0
    return math.sqrt(2.0 * G * drop_m * max(0.0, min(1.0, k_eff)))


def velocity_from_monitoring(displacement_m: float, duration_s: float) -> float:
    """情景 B：监测位移速率推算平均滑速（v = Δs/Δt）。"""
    if duration_s <= 0:
        return 0.0
    return abs(displacement_m) / duration_s


def _f_vertical(froude: float) -> float:
    """垂直运动项的经验系数 f(v/√(gh))（文献 [2] 图 3-18 的分段取值）。

    原文：<0.5 取 1.0；0.5–2.0 查图 3-18 曲线；>2.0 取 ≈1.0。
    本实现对 0.5–2.0 段做**端点线性内插**（近似），并在结果里通过 froude 暴露实际取值，
    便于以后拿到该图后用真实曲线替换。
    """
    if froude <= 0.5 or froude >= 2.0:
        return 1.0
    # 图 3-18 的曲线在 0.5–2.0 区间介于 1.0 与 ~0.6 之间，这里取单调过渡的近似
    t = (froude - 0.5) / 1.5
    return 1.0 - 0.4 * t * (1.0 - t) * 2.0


def series_terms(slide_duration_s: float, water_width_m: float, celerity: float) -> int:
    """查表：级数项数由 T/Δt 决定（Δt = B/c）。表：1–3→1、3–5→2、5–7→3、7–9→4…"""
    if celerity <= 0 or water_width_m <= 0:
        return 1
    dt = water_width_m / celerity
    ratio = slide_duration_s / dt if dt > 0 else 0.0
    if ratio <= 3:
        return 1
    return int(math.floor((ratio - 3) / 2)) + 2


def initial_wave(v: float, water_depth_m: float, slide_thickness_m: float) -> tuple[float, float, float]:
    """初始涌浪高度：(水平项, 垂直项, v/√(gh))。"""
    if v <= 0 or water_depth_m <= 0:
        return 0.0, 0.0, 0.0
    froude = v / math.sqrt(G * water_depth_m)
    zeta_x = 1.17 * v / math.sqrt(G * water_depth_m) * water_depth_m      # ζ0x/h = 1.17 v/√(gh)
    f = _f_vertical(v / math.sqrt(G * slide_thickness_m)) if slide_thickness_m > 0 else 1.0
    zeta_y = f * v / math.sqrt(G * slide_thickness_m) * slide_thickness_m  # ζ0y/h = f·v/√(gh)
    return zeta_x, zeta_y, froude


def opposite_wave(zeta0: float, slide_width_m: float, water_width_m: float,
                  k_reflect: float, celerity: float, terms: int) -> float:
    """对岸最大涌浪高度（潘家铮级数解，式 6）。"""
    if zeta0 <= 0 or slide_width_m <= 0 or water_width_m <= 0:
        return 0.0
    total = 0.0
    for n in range(1, 2 * terms, 2):                      # n = 1,3,5,…
        x = slide_width_m / ((2 * n - 1) * water_width_m)
        total += (k_reflect ** (2 * (n - 1))) * math.log(x + math.sqrt(1 + x * x))
    return (2.0 * zeta0 / math.pi) * (1.0 + k_reflect) * total


def estimate(inp: WaveInput, velocity: float, source: str) -> WaveResult:
    """给定入水速度，算一套涌浪结果。

    标定发现（2026-09-15，用《基于潘家铮法…》里的索风营算例）：
      水平项 ζ0x = 1.17·v·√(h/g) 在 v=15.12 m/s、h=15.25 m 时**精确复现原文的 22.06 m**；
      而垂直项 ζ0y = f·v·√(t/g) 用的是**滑体厚度** t，白家包 t≈70 m 时会算出 40 m 量级。
      原文把两者称为"水平变形运动 / 垂直变形运动"两种**运动模式**下的初始涌浪分量——
      是两种失稳模式的分别结果，**不是同一场滑坡要相加**（相加会把量级抬高一倍以上）。
      因此这里取**主导模式**（两者取大），并把两项都留在结果里便于复核。
    """
    zx, zy, froude = initial_wave(velocity, inp.water_depth_m, inp.slide_thickness_m)
    z0 = max(zx, zy)
    c = math.sqrt(G * inp.water_depth_m) * math.sqrt(
        max(0.0, 1.0 + 1.5 * z0 / inp.water_depth_m + 0.5 * (z0 / inp.water_depth_m) ** 2))
    terms = series_terms(inp.slide_duration_s, inp.water_width_m, c)
    opp = opposite_wave(z0, inp.slide_width_m, inp.water_width_m, inp.k_reflect, c, terms)
    return WaveResult(
        velocity_mps=velocity, velocity_source=source,
        zeta0_horizontal_m=zx, zeta0_vertical_m=zy, zeta0_m=z0,
        opposite_max_m=opp, series_terms=terms, celerity_mps=c, froude=froude,
    )


def estimate_scenarios(inp: WaveInput, monitored_speed_mps: float | None = None) -> dict:
    """速度两口径 × 反射系数区间 → 情景表（用于页面展示与保守取值）。

    返回：
      scenarios: {"drop": WaveResult, "monitoring": WaveResult | None}
      summary:   {"opposite_min_m", "opposite_max_m", "advisory_m"} —— 保守上限用于告警
    """
    v_drop = velocity_from_drop(inp.drop_m, inp.k_eff)
    scenarios: dict[str, WaveResult | None] = {"drop": estimate(inp, v_drop, "drop")}
    if monitored_speed_mps is not None:
        scenarios["monitoring"] = estimate(inp, abs(monitored_speed_mps), "monitoring")
    else:
        scenarios["monitoring"] = None

    vals = []
    for r in scenarios.values():
        if r is None:
            continue
        for k in (K_REFLECT_MIN, K_REFLECT_MAX):
            val = opposite_wave(r.zeta0_m, inp.slide_width_m, inp.water_width_m, k,
                                r.celerity_mps, r.series_terms)
            vals.append(val)
    return {
        "scenarios": scenarios,
        "summary": {
            "opposite_min_m": round(min(vals), 2) if vals else 0.0,
            "opposite_max_m": round(max(vals), 2) if vals else 0.0,
            "advisory_m": round(max(vals), 2) if vals else 0.0,   # 保守：取最大
        },
    }


# ===========================================================================
# B 档 · Heller / Fritz 族（厚滑体入深水）
# 出处：Heller V. (2007) Diss. ETH No. 17531
# 逐条核对过程见 docs/涌浪模型_公式核对_Heller2007.md
# ===========================================================================


@dataclass(frozen=True)
class HellerResult:
    """B 档结果。

    `applicable=False` 表示**前提不成立、根本不出数**（例如滑体质心已没入水面，
    "陆上滑坡从空中入水"这个前提就不存在）；此时所有数值字段无意义，不得展示。
    `violations` 非空则是另一回事：前提成立但落在标定域外（外推，需显式标注）。
    """
    velocity_mps: float
    velocity_source: str
    applicable: bool              # 前提是否成立
    unavailable_reason: str       # 不适用时的原因（直接可展示）
    centroid_drop_m: float        # Δz_sc：质心释放高程 − 静水面高程
    froude: float                 # F = v/√(g·h)
    s_rel: float                  # S = s/h
    m_rel: float                  # M = m_s/(ρ_w·b·h²)
    p_impulse: float              # P = F·S^(1/2)·M^(1/4)·(cosβ)^(1/2)
    beta_deg: float               # β = (6/7)·α
    amplitude_max_m: float        # a_M，式 5.3
    height_max_m: float           # H_M，式 5.5
    period_s: float               # T_M，式 5.6
    x_max_m: float                # x_M，式 5.4（最大波幅出现位置）
    primary_volume_m3: float      # V_cP，式 5.8
    wave_type: str                # stokes | cnoidal_solitary | bore
    in_domain: bool
    violations: tuple[str, ...]


def velocity_from_drop_friction(drop_m: float, alpha_deg: float,
                                delta_deg: float = DELTA_DEFAULT) -> float:
    """原文式 6.1：V_s = [2·g·Δz_sc·(1 − tanδ·cotα)]^(1/2)。

    这是**文献自己的**滑速口径（几何 + 动床摩擦角），与 `velocity_from_drop`
    的 k_eff 简化式并列保留。α→90° 时 cotα→0，退化为自由落体 √(2gΔz)；
    α ≤ δ 时滑体无法加速，返回 0（原文未定义该情形）。
    """
    if drop_m <= 0:
        return 0.0
    a = math.radians(max(0.0, min(90.0, alpha_deg)))
    if a <= 0.0 or math.tan(a) <= 0.0:
        return 0.0
    factor = 1.0 - math.tan(math.radians(delta_deg)) / math.tan(a)
    if factor <= 0.0:
        return 0.0
    return math.sqrt(2.0 * G * drop_m * factor)


def heller_dimensionless(v: float, h: float, s: float, b: float,
                         volume_m3: float, rho_s: float,
                         alpha_deg: float) -> dict[str, float]:
    """原文 NOTATION 定义的四个无量纲量 + 有效角 β。

    F = v/√(g·h)、S = s/h、M = m_s/(ρ_w·b·h²)（m_s = ρ_s·V）、β = (6/7)·α、
    P = F·S^(1/2)·M^(1/4)·(cosβ)^(1/2)。
    """
    beta_deg = (6.0 / 7.0) * alpha_deg
    froude = v / math.sqrt(G * h) if h > 0 else 0.0
    s_rel = s / h if h > 0 else 0.0
    m_rel = volume_m3 * rho_s / (RHO_W * b * h * h) if (b > 0 and h > 0) else 0.0
    cosb = math.cos(math.radians(beta_deg))
    p_impulse = 0.0
    if froude > 0 and s_rel > 0 and m_rel > 0 and cosb > 0:
        p_impulse = froude * math.sqrt(s_rel) * m_rel ** 0.25 * math.sqrt(cosb)
    return {"F": froude, "S": s_rel, "M": m_rel, "P": p_impulse, "beta_deg": beta_deg}


def heller_near_field(p_impulse: float, h: float) -> tuple[float, float, float, float]:
    """近场四式：(a_M, H_M, T_M, x_M)。式 5.3 / 5.5 / 5.6 / 5.4。"""
    if p_impulse <= 0 or h <= 0:
        return 0.0, 0.0, 0.0, 0.0
    p45 = p_impulse ** 0.8                       # P^(4/5)
    a_max = (4.0 / 9.0) * p45 * h
    h_max = (5.0 / 9.0) * p45 * h
    t_period = 9.0 * math.sqrt(p_impulse) * math.sqrt(h / G)
    x_max = (11.0 / 2.0) * math.sqrt(p_impulse) * h
    return a_max, h_max, t_period, x_max


def heller_primary_volume(p_impulse: float, b: float, h: float) -> float:
    """首波体积 V_cP = P^(6/5)·b·h²（式 5.8）。"""
    if p_impulse <= 0 or b <= 0 or h <= 0:
        return 0.0
    return p_impulse ** 1.2 * b * h * h


def heller_wave_type(froude: float, s_rel: float, m_rel: float, beta_deg: float) -> str:
    """波型判别（式 5.25–5.27）。判据 q = S^(1/3)·M·cosβ 对两个阈值。"""
    if froude <= 0 or s_rel <= 0 or m_rel <= 0:
        return "unknown"
    q = s_rel ** (1.0 / 3.0) * m_rel * math.cos(math.radians(beta_deg))
    stokes_upper = (4.0 / 5.0) * froude ** (-7.0 / 5.0)
    bore_lower = 11.0 * froude ** (-5.0 / 2.0)
    if q < stokes_upper:
        return "stokes"
    if q <= bore_lower:
        return "cnoidal_solitary"
    return "bore"


def heller_domain(froude: float, s_rel: float, m_rel: float,
                  p_impulse: float) -> tuple[bool, tuple[str, ...]]:
    """检查四个无量纲量是否落在原文 Table 5.1 的标定域内。"""
    bad: list[str] = []
    for name, value in (("F", froude), ("S", s_rel), ("M", m_rel), ("P", p_impulse)):
        lo, hi = HELLER_LIMITS[name]
        if not (lo <= value <= hi):
            bad.append(name)
    return (not bad), tuple(bad)


def heller_decay(p_impulse: float, h: float, x_m: float) -> float | None:
    """波幅沿程衰减 a(x) = (3/5)·[P·X^(-1/3)]^(4/5)·h（式 5.20）。

    **仅当 10 ≤ X = x/h ≤ 59 时有效**，否则返回 None（原文 p.146 明确 X→0 时发散）。
    超出上界（>59）原文未标定；低于下界属近场，应改用 a_M。
    """
    if p_impulse <= 0 or h <= 0 or x_m <= 0:
        return None
    x_rel = x_m / h
    if not (HELLER_X_DECAY_MIN <= x_rel <= HELLER_X_DECAY_MAX):
        return None
    return (3.0 / 5.0) * (p_impulse * x_rel ** (-1.0 / 3.0)) ** 0.8 * h


def heller_at_opposite(p_impulse: float, h: float, distance_m: float) -> tuple[float, bool]:
    """对岸（距离 distance_m 处）波幅及是否用了衰减式。

    返回 (波幅 m, 是否由式 5.20 给出)。若 X < 10（水库太窄、波还没开始衰减），
    退化为近场最大值 a_M 并返回 False —— 这是保守取法，页面必须标出来。
    """
    decayed = heller_decay(p_impulse, h, distance_m)
    if decayed is not None:
        return decayed, True
    a_max, _, _, _ = heller_near_field(p_impulse, h)
    return a_max, False


def heller_applicability(inp: WaveInput) -> tuple[bool, str]:
    """B 档的**前提**检查（与"是否落在标定域"是两件事）。

    原文 p.74 与 Figure 6.8 明确：Δz_sc 是**滑体质心到静水面**的落差，
    V_s 是**入水那一瞬**的速度（609 m 量到 0 m 水位线，不是 −122 m 河床）。

    若质心高程 ≤ 静水面高程，说明滑体基本已没入水面——"陆上滑坡入水"这个前提
    根本不成立，此时**不出数**，而不是给个外推值再写备注。
    """
    if inp.centroid_elev_m is None or inp.water_level_m is None:
        return False, ("未提供滑体质心高程 / 静水面高程，无法判定 B 档前提"
                       "（需从剖面量算后填入）")
    dz = inp.centroid_drop_m
    if dz <= 0:
        return False, (f"滑体质心已没入水面：Δz_sc = {dz:.1f} m"
                       f"（质心 {inp.centroid_elev_m:.0f} m − 水面 {inp.water_level_m:.0f} m），"
                       f"陆上滑坡入水的前提不成立")
    return True, ""


def estimate_heller(inp: WaveInput, velocity: float | None = None,
                    source: str = "eq6_1") -> HellerResult:
    """B 档（Heller/Fritz 族）。

    `velocity=None`（默认）时按**原文式 6.1** 用它自己的 Δz_sc 算入水速度——
    这是该档的正确口径，与潘家铮档的 `drop_m` 不是同一个量。
    传入 velocity 只用于"监测速率"这类外部给定情景，调用方应标注为外推。
    """
    applicable, reason = heller_applicability(inp)
    dz = inp.centroid_drop_m
    v = (velocity if velocity is not None
         else velocity_from_drop_friction(dz, inp.alpha_deg, inp.delta_deg))

    if not applicable:
        # 前提不成立：**不算近场**，数值一律置零，避免被误读成"波很小"
        return HellerResult(
            velocity_mps=0.0, velocity_source=source,
            applicable=False, unavailable_reason=reason, centroid_drop_m=dz,
            froude=0.0, s_rel=0.0, m_rel=0.0, p_impulse=0.0, beta_deg=0.0,
            amplitude_max_m=0.0, height_max_m=0.0, period_s=0.0, x_max_m=0.0,
            primary_volume_m3=0.0, wave_type="unknown",
            in_domain=False, violations=(),
        )

    d = heller_dimensionless(v, inp.water_depth_m, inp.slide_thickness_m,
                             inp.slide_width_m, inp.volume_m3, inp.rho_s_kgm3,
                             inp.alpha_deg)
    a_max, h_max, t_period, x_max = heller_near_field(d["P"], inp.water_depth_m)
    in_domain, violations = heller_domain(d["F"], d["S"], d["M"], d["P"])
    return HellerResult(
        velocity_mps=v, velocity_source=source,
        applicable=True, unavailable_reason="", centroid_drop_m=dz,
        froude=d["F"], s_rel=d["S"], m_rel=d["M"], p_impulse=d["P"],
        beta_deg=d["beta_deg"],
        amplitude_max_m=a_max, height_max_m=h_max, period_s=t_period, x_max_m=x_max,
        primary_volume_m3=heller_primary_volume(d["P"], inp.slide_width_m, inp.water_depth_m),
        wave_type=heller_wave_type(d["F"], d["S"], d["M"], d["beta_deg"]),
        in_domain=in_domain, violations=violations,
    )


def _watts_section(inp: WaveInput) -> dict | None:
    """C 档（Watts 方块）小节。**不参与告警** —— 它的输入是"把天然滑坡映射到
    理想化方块"的结果，映射口径未与现场几何核定前，只能展示、不能进判定。"""
    b, d, th = inp.watts_block_size_m, inp.watts_submergence_m, inp.watts_theta_deg
    if b is None or d is None or th is None:
        return None
    out = estimate_watts(WattsInput(block_size_m=b, submergence_m=d,
                                    rho_b=inp.rho_s_kgm3, theta_deg=th,
                                    water_depth_m=inp.water_depth_m))
    out["mapping"] = {
        "b_rule": "面积等效：b = √(2A)，A 为剖面量出的滑体截面积",
        "d_rule": "滑体质心相对静水面的淹没深度",
        "theta_rule": "滑面首末弦倾角（后缘 → 剪出口）",
        "values": {"b_m": b, "d_m": d, "theta_deg": th},
    }
    out["in_advisory"] = False
    out["in_advisory_reason"] = "映射口径未与现场几何核定，暂不参与告警判定"
    return out


def estimate_full(inp: WaveInput, monitored_speed_mps: float | None = None,
                  opposite_distance_m: float | None = None) -> dict:
    """两档并列的唯一入口（供 /api/wave 使用）。

    **两档各用自己口径的入水速度**——这不是双标，是两套方法本来就不是一个量：

      * 潘家铮档：`v = √(2·g·drop_m·k_eff)`，`drop_m` = 滑面总高差（后缘 → 剪出口）；
      * Heller 档：原文式 6.1 `v = √(2·g·Δz_sc·(1 − tanδ·cotα))`，
        `Δz_sc` = 滑体质心**到静水面**的落差（Figure 6.8 实证）。

    另有"监测速率"情景：两档都用外部给定速率，明确标注为外推（文献不这么做）。

    返回里 `heller.applicable=False` 表示**前提不成立、该档不出数**——
    此时 `heller` 里只有原因，没有任何数值，避免被误读成"波很小"。
    """
    if opposite_distance_m is None:
        opposite_distance_m = inp.water_width_m

    v_drop = velocity_from_drop(inp.drop_m, inp.k_eff)      # 潘家铮档自己的口径
    mon = abs(monitored_speed_mps) if monitored_speed_mps is not None else None
    applicable, _reason = heller_applicability(inp)

    scenarios = [
        # (键, 显示名, 潘家铮速度, Heller 速度；Heller 传 None = 用原文式 6.1)
        ("drop", "失稳情景（各按原文口径）", v_drop if v_drop > 0 else None, None),
        ("monitoring", "监测速率（外部输入 · 外推）", mon, mon),
    ]

    rows: list[dict] = []
    envelope = 0.0

    for key, label, v_pan, v_hel in scenarios:
        if v_pan is None or v_pan <= 0:
            continue
        pr = estimate(inp, v_pan, key)
        hr = estimate_heller(inp, v_hel,
                             "monitoring" if v_hel is not None else "eq6_1")

        # 潘家铮对岸：反射系数取区间两端，给一个保守区间
        p_vals = [
            opposite_wave(pr.zeta0_m, inp.slide_width_m, inp.water_width_m, k,
                          pr.celerity_mps, pr.series_terms)
            for k in (K_REFLECT_MIN, K_REFLECT_MAX)
        ]
        pan_payload = {
            "velocity_mps": round(v_pan, 2),
            "velocity_note": ("v=√(2g·drop_m·k_eff)，drop_m = 滑面总高差"
                              if v_hel is None else "外部给定（监测速率）"),
            "zeta0_m": round(pr.zeta0_m, 2),
            "opposite_min_m": round(min(p_vals), 2),
            "opposite_max_m": round(max(p_vals), 2),
            "celerity_mps": round(pr.celerity_mps, 2),
            "froude": round(pr.froude, 3),
            # 如实交代两件事，不宣称"超域"（那没有出处）
            "caveat": ("本档无公开适用域（文献 [1][2] 未给）；入水速度用的是简化能量式 + k_eff，"
                       "不是潘家铮法的条分法口径"),
        }

        hel_payload: dict = {
            "applicable": hr.applicable,
            "unavailable_reason": hr.unavailable_reason,
            "centroid_drop_m": round(hr.centroid_drop_m, 1),
            "velocity_source": hr.velocity_source,
        }
        if hr.applicable:
            h_opp, h_decayed = heller_at_opposite(hr.p_impulse, inp.water_depth_m,
                                                  opposite_distance_m)
            hel_payload.update({
                "velocity_mps": round(hr.velocity_mps, 2),
                "P": round(hr.p_impulse, 3),
                "F": round(hr.froude, 3),
                "S": round(hr.s_rel, 3),
                "M": round(hr.m_rel, 3),
                "amplitude_max_m": round(hr.amplitude_max_m, 2),
                "height_max_m": round(hr.height_max_m, 2),
                "period_s": round(hr.period_s, 1),
                "x_max_m": round(hr.x_max_m, 1),
                "primary_volume_m3": round(hr.primary_volume_m3, 1),
                "wave_type": hr.wave_type,
                "wave_type_cn": WAVE_TYPE_CN.get(hr.wave_type, "—"),
                "at_opposite_m": round(h_opp, 2),
                "at_opposite_uses_decay": h_decayed,
                "in_domain": hr.in_domain,
                "violations": list(hr.violations),
            })
            envelope = max(envelope, hr.amplitude_max_m, h_opp)
        envelope = max(envelope, max(p_vals))

        rows.append({"scenario": key, "label": label,
                     "panjiazheng": pan_payload, "heller": hel_payload})

    return {
        "input": {
            "volume_m3": inp.volume_m3,
            "slide_width_m": inp.slide_width_m,
            "water_width_m": inp.water_width_m,
            "water_depth_m": inp.water_depth_m,
            "slide_thickness_m": inp.slide_thickness_m,
            "drop_m": inp.drop_m,
            "centroid_elev_m": inp.centroid_elev_m,
            "water_level_m": inp.water_level_m,
            "centroid_drop_m": round(inp.centroid_drop_m, 1),
            "rho_s_kgm3": inp.rho_s_kgm3,
            "alpha_deg": inp.alpha_deg,
            "delta_deg": inp.delta_deg,
            "opposite_distance_m": opposite_distance_m,
        },
        "rows": rows,
        "heller_applicable": applicable,
        "watts": _watts_section(inp),
        # 告警口径：只有"前提成立且域内"的档才有资格进告警（见 wave_advisory 文档）
        "advisory": wave_advisory(rows),
        "limits": {k: list(v) for k, v in HELLER_LIMITS.items()},
        "summary": {
            "advisory_m": round(envelope, 2),
            "note": "advisory 取两档全部口径的最大值，仅供告警，不得作为结论或避险依据",
        },
    }
