"""滑坡涌浪估算接口。

POST /api/wave
  请求体二选一（也可混用：给了 site 再覆盖任意字段）：
    A) {"site": "baijiabao"}                      —— 用内置预设
    B) {"volume_m3": ..., "water_depth_m": ...}   —— 直接给全部几何参数

  返回两档方法（潘家铮法 + Heller/Fritz 族）× 三个速度口径的**并列**结果，
  每档都带适用域检查（越界项显式列出）。**接口不替用户挑一个数**——
  选型是解释性判断，必须由人在页面上看到域标志后决定。

权限沿用全局口径：读取=登录用户。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from services.auth import Principal, current_principal
from database import Prediction, get_db
from services.wave_presets import PRESETS
from services.wave import (
    ALPHA_DEFAULT, DELTA_DEFAULT, HELLER_LIMITS, RHO_S_DEFAULT, WAVE_TYPE_CN,
    WaveInput, estimate_full,
)

router = APIRouter(prefix="/api", tags=["wave"])

# 内置预设。数值来源见 web/docs/P24 与 docs/涌浪模型_公式核对_Heller2007.md；
# **alpha / drop 仍待现场剖面确认**，这里给的是当前工作值，页面上标注为"待确认"。


class WaveBody(BaseModel):
    """全部字段可选：给 site 用预设，或直接给几何参数。"""
    site: str | None = None
    volume_m3: float | None = Field(default=None, gt=0)
    slide_width_m: float | None = Field(default=None, gt=0)
    water_width_m: float | None = Field(default=None, gt=0)
    water_depth_m: float | None = Field(default=None, gt=0)
    slide_thickness_m: float | None = Field(default=None, gt=0)
    drop_m: float | None = Field(default=None, gt=0, description="滑面总高差（潘家铮档）")
    runout_m: float | None = Field(default=None, ge=0)
    slide_duration_s: float | None = Field(default=None, gt=0)
    # B 档（Heller）的落差口径：质心高程 − 静水面高程。
    # **允许 0 与负值**——负值本身是有意义的结论（质心已没入水面，B 档前提不成立）。
    centroid_elev_m: float | None = None
    water_level_m: float | None = None
    # C 档（Watts 方块）的映射参数：同样是"我们定的"，不是现场观测量
    watts_block_size_m: float | None = Field(default=None, gt=0)
    watts_submergence_m: float | None = Field(default=None, ge=0)
    watts_theta_deg: float | None = Field(default=None, gt=0, le=90)
    rho_s_kgm3: float | None = Field(default=None, gt=0)
    alpha_deg: float | None = Field(default=None, gt=0, le=90)
    delta_deg: float | None = Field(default=None, ge=0, lt=90)
    k_reflect: float | None = Field(default=None, ge=0, le=1)
    k_eff: float | None = Field(default=None, gt=0, le=1)
    monitored_speed_mps: float | None = Field(default=None, ge=0)
    opposite_distance_m: float | None = Field(default=None, gt=0)


# 无默认值、必须给全的几何量
_REQUIRED_FIELDS = (
    "volume_m3", "slide_width_m", "water_width_m", "water_depth_m",
    "slide_thickness_m", "drop_m", "runout_m", "slide_duration_s",
)
# 在 WaveInput 里有默认值，可省
_OPTIONAL_FIELDS = ("rho_s_kgm3", "alpha_deg", "delta_deg", "k_reflect", "k_eff",
                    "centroid_elev_m", "water_level_m",
                    "watts_block_size_m", "watts_submergence_m", "watts_theta_deg")
_GEOM_FIELDS = _REQUIRED_FIELDS + _OPTIONAL_FIELDS


@router.get("/wave/presets")
def wave_presets(principal: Principal = Depends(current_principal)) -> dict:
    """可用预设（前端下拉用）。"""
    return {
        "presets": [
            {
                "id": key,
                "name": p["name"],
                "note": p["note"],
                "unconfirmed": p.get("unconfirmed", []),
                "input": {k: p[k] for k in _GEOM_FIELDS if k in p},
            }
            for key, p in PRESETS.items()
        ],
        "limits": {k: list(v) for k, v in HELLER_LIMITS.items()},
        "defaults": {"rho_s_kgm3": RHO_S_DEFAULT, "alpha_deg": ALPHA_DEFAULT,
                     "delta_deg": DELTA_DEFAULT},
    }


@router.get("/wave/status")
def wave_status(db: Session = Depends(get_db),
                principal: Principal = Depends(current_principal)) -> dict:
    """已绑定点位的**最近一次轮询推演结论**（只读）。

    数据来自 `services/wave_watch.py` 每轮写入的 `wave:<site>` 记录。
    与 `POST /api/wave`（按需计算、可带任意参数）不同，这里看到的是"轮询实际跑出来的东西"，
    用来核对线上链路是否真的在跑。
    """
    rows = db.execute(
        select(Prediction).where(Prediction.device_id.like("wave:%"))
        .order_by(Prediction.ts.desc()).limit(200)
    ).scalars().all()
    latest: dict[str, dict] = {}
    for r in rows:
        site = r.device_id.split(":", 1)[1]
        if site in latest:
            continue
        latest[site] = {
            "site_id": site,
            "ts": r.ts.isoformat() if r.ts else None,
            "level": r.combined_level,
            "stage": r.stage,
        }
    return {"sites": list(latest.values()), "note": "来自轮询写入的 wave:<site> 记录"}


@router.post("/wave")
def wave_estimate(body: WaveBody,
                  principal: Principal = Depends(current_principal)) -> dict:
    """两档方法并列估算。"""
    params: dict = {}
    preset_meta: dict | None = None
    if body.site:
        preset = PRESETS.get(body.site)
        if preset is None:
            raise HTTPException(404, f"未知预设 {body.site}，可用：{', '.join(PRESETS)}")
        params.update({k: preset[k] for k in _GEOM_FIELDS if k in preset})
        preset_meta = {
            "id": body.site, "name": preset["name"], "note": preset["note"],
            "unconfirmed": preset.get("unconfirmed", []),
        }

    for name in _GEOM_FIELDS:
        value = getattr(body, name)
        if value is not None:
            params[name] = value

    missing = [k for k in _REQUIRED_FIELDS if k not in params]
    if missing:
        raise HTTPException(
            422,
            f"缺少参数：{', '.join(missing)}"
            f"（可省略 {', '.join(_OPTIONAL_FIELDS)}，已给默认值；也可给 site 用预设）",
        )

    try:
        inp = WaveInput(**params)
    except TypeError as exc:
        raise HTTPException(422, f"参数不合法：{exc}") from exc

    out = estimate_full(inp, monitored_speed_mps=body.monitored_speed_mps,
                        opposite_distance_m=body.opposite_distance_m)
    out["preset"] = preset_meta
    out["wave_type_cn"] = WAVE_TYPE_CN
    return out
