"""给三个**演示监测点**造序列，让大屏同时出现 1/2/4 级（以及按需的 3 级）。

为什么需要它：哨兵层的 1/2/3 级是**加速过程中的过渡态** ——
一个自然演化的点要么还在爬、要么已经稳在高位（4 级）、要么一直平稳（0 级），
所以任意时刻只看得到两个端点（现在就是 0 级和 4 级）。把几个点分别停在
自己加速曲线的不同阶段，五个级别才能同框。

**安全边界（重要）**：本脚本只碰 `demo-node-01/02/03` 这三个 id 的读数、
预测与告警，**绝不触碰 slope-node-01/02** —— 其中 slope-node-01 是真实硬件节点，
线上 seed_demo_data.py 里那句 `delete where device_id='slope-node-01'`
一旦被误跑就会把真实读数删掉，所以这里另写一份、只做加法。

速率 → 等级的实测表（`_tools/calibrate_demo_levels.py`，用真实 predictor 跑出来）：

    平稳                 -> 0 级
    0.10 mm/d            -> 1 级（稳定）
    0.14 mm/d            -> 2 级（稳定）
    >=0.18 mm/d          -> 4 级（z>=5 连续 2 天后）
    0.60 mm/d 只开始 2 天 -> 3 级（**过渡态，约 2 天后升为 4**）

**3 级无法长期稳定** —— 这是算法定义决定的（z>=5 连续 2 天即为 4 级），不是造不出来。
所以：
  * 默认跑（不加参数）：A→1 级、B→2 级、C→4 级，三个都是稳定态；
  * 演示当天跑 `--scenario level3`：把 C 重置成"刚越过阈值"的 3 级，
    五级同框（0 级由真实的 slope-node-01 提供，4 级另有自然演化的 slope-node-02）。

用法：
  cd web/backend
  python scripts/seed_demo_nodes.py                 # 稳定态（1/2/4）
  python scripts/seed_demo_nodes.py --scenario level3   # 演示前刷新，把 C 变 3 级
  python scripts/seed_demo_nodes.py --only demo-node-01 # 只重做某一个
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database import Alert, Prediction, SensorReading, SessionLocal, init_db  # noqa: E402

DAYS = 180
FLAT_DAILY = 0.02
FLAT_SD = 0.03

# (device_id, 随机种子, 目标等级)
#
# 默认场景（demo）：1 级 + 2 级 + 3 级 —— 演示前跑一次，加上真实的
#   slope-node-01（0 级）与自然演化的 slope-node-02（4 级），五个级别同框。
#   代价：3 级是过渡态，约 2 天后会自动升为 4 级。
# 备选场景（stable）：1 级 + 2 级 + 4 级 —— 三个都是长期稳定态，适合非演示时段。
# 四个演示点覆盖 0/1/2/3 级（4 级由自然演化的 slope-node-02 提供）
DEMO = [("demo-node-01", 101, 0), ("demo-node-02", 202, 1),
        ("demo-node-03", 303, 2), ("demo-node-04", 404, 3)]
STABLE = [("demo-node-01", 101, 0), ("demo-node-02", 202, 1),
          ("demo-node-03", 303, 2), ("demo-node-04", 404, 4)]

# 目标等级 → (加速段起始日, 候选速率网格 mm/d)
#
# 为什么必须"搜索"而不是写死速率：z 的分母是该点**安静段的稳健尺度 σ**，
# 而 σ 是从随机抽样里估计出来的 —— 换一个种子，同一个速率会落到不同等级
# （实测：0.14 mm/d 在种子 7 下是 2 级，在种子 202 下是 1 级）。
# 所以这里对每个点逐个试，用**真实的 predictor**（与线上同一条路径）探测，
# 命中目标就停，并把最终选用的速率打出来备查。
GRID = {
    # 0 级：全程平稳（step_day 取到序列之外 = 不设加速段）。
    # 速率取 0.02 与 device_manager 里 demo-node-01 的固定速率保持一致 ——
    # 种子用 0.0、而线上按 0.02 推进的话，尾巴与实时段速率不同源。
    0: (DAYS, [0.02]),
    # 网格是**实测定出来的**，不是拍的：z = (近 24h 增量 − 安静段中位数)/σ，
    # 而 σ 通常只有 0.03~0.04 mm/d、中位数约 0.03，于是
    #   1 级（2.5 ≤ z < 4）≈ 速率 0.12~0.17
    #   2 级（4 ≤ z < 5）  ≈ 速率 0.17~0.22
    # 每级只覆盖约 0.05 mm/d 宽，网格必须够密——早先 1 级网格上限只到 0.12，
    # 结果实测 z=2.30 差一点点没够 2.5，怎么试都落在 0 级。
    1: (160, [0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17]),
    2: (160, [0.16, 0.17, 0.18, 0.19, 0.20, 0.21, 0.22, 0.24]),
    3: (DAYS - 2, [0.35, 0.40, 0.50, 0.60, 0.80, 1.00, 1.20]),
    4: (160, [0.20, 0.22, 0.25, 0.28, 0.32, 0.40]),
}


def probe_level(device_id: str) -> int:
    """按**线上同一条口径**算当下等级：load_series + load_raw_series → predictor。

    与 `ingest.evaluate_device` 的取数、推理完全一致，只是**不落库**，
    所以可以放心拿它来做参数搜索。
    """
    from services import ingest
    from services.predictor import predictor

    df = ingest.load_series(device_id, days=400)
    raw = ingest.load_raw_series(device_id, days=ingest.SENTINEL_RAW_DAYS)
    if df is None or len(df) < 30:
        return -1
    return int(predictor.predict_series(df, raw_df=raw)[-1]["combined_level"])


def catch_up(device_id: str) -> None:
    """按轮询线程的做法补一条"当下"读数，再探测。

    为什么必须补：种子只写到"昨天 23:59"（与标定脚本同一形态），而线上轮询
    每分钟追加一条。第一条追加时 `elapsed_days` 是十几个小时，会产生一次**补齐跳变**，
    它改变近 24 h 滚动增量 —— 实测不补这一条时探测到 1 级、线上跑一分钟就变 0 级。
    先补上，探测结果才代表真实运行状态。
    """
    from services import ingest
    from services import virtual_device

    ingest.save_reading(device_id, virtual_device.advance(device_id),
                        source="simulation")


def seed(device_id: str, seed_no: int, step_day: int, rate: float) -> int:
    """重造该演示点的序列；返回写入条数。

    形态刻意与 `_tools/calibrate_demo_levels.py` 一致：**前 179 天是日尺度，
    最后 1 天是分钟级**。为什么要这一步：线上节点被轮询线程按分钟追加读数，
    哨兵层的当前值吃的是"近 24 h 滚动增量"，日尺度-only 与带分钟尾段算出来的
    z 不同（实测 0.14 mm/d 在两种形态下分别是 1 级和 2 级）。种子必须复现线上形态，
    否则种下去是 2 级、几分钟后自己变成 1 级。
    """
    rng = np.random.default_rng(seed_no)
    db = SessionLocal()
    try:
        # 只清自己的
        for model in (SensorReading, Prediction, Alert):
            for row in db.query(model).filter(model.device_id == device_id).all():
                db.delete(row)
        db.commit()

        t0 = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) \
            - timedelta(days=DAYS)
        disp = 6.0
        n = 0
        last_daily = FLAT_DAILY
        for i in range(DAYS - 1):                      # 日尺度历史
            ts = t0 + timedelta(days=i)
            doy = ts.timetuple().tm_yday
            season = 1.0 + 0.6 * np.sin(2 * np.pi * (doy - 120) / 365)
            if i >= step_day:
                daily = rate + rng.normal(0, 0.01)
            else:
                daily = FLAT_DAILY + rng.normal(0, FLAT_SD)
            last_daily = max(daily, 0.0)
            disp += last_daily
            db.add(SensorReading(
                device_id=device_id, ts=ts, source="simulation",
                R=1.2 + rng.normal(0, 0.25) + (0.4 if i >= step_day else 0),
                P=0.9 + rng.normal(0, 0.2),
                T=18 + 7 * np.sin(2 * np.pi * (doy - 100) / 365) + rng.normal(0, 0.6),
                H=55 + 5 * season + rng.normal(0, 3),
                RN=max(0.0, rng.gamma(1.4, 4.0) * season - 2.0),
                S=35 + 5 * season + rng.normal(0, 2),
                D=round(float(disp), 3),
            ))
            n += 1

        # 最后 1 天：分钟级，速率沿用末段（线上轮询就是这个形态）
        t_last = t0 + timedelta(days=DAYS - 1)
        for k in range(1440):
            disp += last_daily / 1440.0
            # 必须正好覆盖 t_last 这一天（k 从 0 起）：若多跨到次日，
            # 次日只有 1 条读数、日增量≈0，末级会被算成 0 级（实测踩过）。
            ts = t_last + timedelta(minutes=k)
            doy = ts.timetuple().tm_yday
            season = 1.0 + 0.6 * np.sin(2 * np.pi * (doy - 120) / 365)
            db.add(SensorReading(
                device_id=device_id, ts=ts, source="simulation",
                R=1.2 + rng.normal(0, 0.25) + (0.4 if step_day is not None else 0),
                P=0.9 + rng.normal(0, 0.2),
                T=18 + 7 * np.sin(2 * np.pi * (doy - 100) / 365) + rng.normal(0, 0.6),
                H=55 + 5 * season + rng.normal(0, 3),
                RN=max(0.0, rng.gamma(1.4, 4.0) * season - 2.0),
                S=35 + 5 * season + rng.normal(0, 2),
                D=round(float(disp), 3),
            ))
            n += 1
        db.commit()
        return n
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=["demo", "stable"], default="demo",
                    help="demo=1/2/3 级（演示前跑，五级同框）；"
                         "stable=1/2/4 级（三个都是长期稳定态）")
    ap.add_argument("--only", default="", help="只重做指定 device_id")
    args = ap.parse_args()

    from scripts.backfill_predictions import backfill
    from services import ingest

    init_db()
    plan = STABLE if args.scenario == "stable" else DEMO
    if args.only:
        plan = [p for p in plan if p[0] == args.only] or [
            p for p in (DEMO + STABLE) if p[0] == args.only]
    print(f"场景 = {args.scenario}")
    for device_id, seed_no, want in plan:
        step_day, grid = GRID[want]
        hit, tries = None, []
        for rate in grid:
            seed(device_id, seed_no, step_day, rate)
            catch_up(device_id)
            got = probe_level(device_id)
            tries.append(f"{rate}->{got}")
            if got == want:
                hit = rate
                break
        if hit is None:
            print(f"  !! {device_id}: 试过 [{' '.join(tries)}]，没有落到 {want} 级")
            continue
        # 命中后再回放历史（只重建 derivations）、并用线上口径写一条当下的预测
        info = backfill(device_id)
        live = ingest.evaluate_device(device_id) or {}
        got = live.get("combined_level", info.get("last_level"))
        print(f"  {'OK ' if got == want else '!! '}{device_id}: 速率 {hit} mm/d"
              f"（第 {step_day} 天起）-> {got} 级；探测过程 [{' '.join(tries)}]"
              f"；回放警示 {info.get('actions')}")
    if args.scenario == "demo":
        print("提示：3 级是过渡态，约 2 天后会自动升为 4 级；演示前重跑一次本脚本即可刷新。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
