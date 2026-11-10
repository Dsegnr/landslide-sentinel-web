"""设备与通信运维的计算层（第 4 个页面「设备与通信」的数据来源）。

它回答的是**通信侧**的问题，不是预警侧的问题：

  * 这台设备的令牌登记了没有、最近一次上报是什么时候、已经断了多久；
  * 上报时延有多大（设备时间戳 → 服务器入库时间），在不在变大；
  * 哪些时段是**断线补传**（入库时间远晚于采集时间）；
  * 逐个通道"最后有值"是什么时候，有没有卡值、有没有越界；
  * 服务器每次收到推送的审计记录（条数、去重数、来源 IP）。

**两条口径纪律（踩过坑，写死在这里）**：

1. 时延与补传**只能用 `source='hardware'` 的行**算。模拟/补齐行的 `created_at`
   是生成时刻、`ts` 是回填的历史时刻，算出来是"几千小时"的假时延。
2. 令牌只回答"登记 / 未登记"，**绝不返回令牌原文**，连片段也不返回。
"""
from __future__ import annotations

from pathlib import Path
from datetime import datetime, timedelta, timezone

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from config import settings
from database import Device, IngestEvent, SensorReading
from services.device_manager import manager
from services.ingest import ALLOWED_CHANNELS, get_baseline, hardware_channels

# 通信状态判定阈值（写死并说明，避免"多久算掉线"各说各话）
ONLINE_MINUTES = 30          # 最近一次上报在 N 分钟内 → 在线
STALE_HOURS = 6              # 超过 N 小时 → 停更
BACKFILL_SECONDS = 300       # 入库时间比采集时间晚超过 N 秒 → 视为补传（正常链路 6~9 秒）
GAP_FACTOR = 3.0             # 上报间隔超过"常态间隔"的 N 倍 → 记一个断连区间
STUCK_REPEAT = 5             # 连续 N 条同一数值 → 提示卡值（实测 T/H 恒定就是这个特征）

# 但有些通道"连续同一个值"本来就是正常状态，不能当卡值报 ——
# 最典型的是雨量：无雨时连续 0.0 是常态。不排除掉的话，运维页会满屏假报警，
# 那比不报还糟（实测踩到：RN 被标成卡值）。RNM（mm 雨量）同理：晴天连着 0。
BENIGN_REPEAT: dict[str, float] = {"RNM": 0.0}

# 通道量程（用于越界检查）。超范围不一定是坏数据，但必须报出来让人判断。
# 口径 2026-09-23：RN = 雨量感应强度 %（平面传感器，0–100）；RNM = 降雨量 mm。
RANGES: dict[str, tuple[float | None, float | None]] = {
    "R": (0.0, 45.0), "P": (0.0, 45.0),
    "T": (-30.0, 60.0), "H": (0.0, 100.0),
    "RN": (0.0, 100.0), "RNM": (0.0, None),
    "S": (0.0, 100.0), "D": (0.0, None),
}


def _naive(dt: datetime | None) -> datetime | None:
    """统一成不带时区的 UTC —— created_at 是 aware、ts 是 naive，直接相减会抛 TypeError。"""
    if dt is None:
        return None
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _since(hours: int) -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)


def _hardware_rows(db: Session, device_id: str, hours: int) -> list[SensorReading]:
    """只取**真实硬件推送**的行 —— 时延/补传只能拿它们算。"""
    return list(db.execute(
        select(SensorReading)
        .where(SensorReading.device_id == device_id,
               SensorReading.source == "hardware",
               SensorReading.ts >= _since(hours))
        .order_by(SensorReading.ts)
    ).scalars().all())


def _last_row(db: Session, device_id: str) -> SensorReading | None:
    return db.execute(
        select(SensorReading).where(SensorReading.device_id == device_id)
        .order_by(SensorReading.ts.desc()).limit(1)
    ).scalars().first()


def _last_hardware_row(db: Session, device_id: str) -> SensorReading | None:
    """最后一条**真实硬件推送** —— 链路在线与否只能看它。"""
    return db.execute(
        select(SensorReading)
        .where(SensorReading.device_id == device_id, SensorReading.source == "hardware")
        .order_by(SensorReading.ts.desc()).limit(1)
    ).scalars().first()


def _registered_tokens() -> set[str]:
    return set(settings.ingest_token_map)


def device_inventory(db: Session) -> list[dict]:
    """设备台账 + 通信健康：每台一行。"""
    reg = _registered_tokens()
    db_rows = {r.device_id: r for r in db.execute(select(Device)).scalars().all()}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    out = []
    for dev in manager.all():
        row = db_rows.get(dev.device_id)
        last = _last_row(db, dev.device_id)
        last_ts = _naive(last.ts) if last else None
        last_hw = _last_hardware_row(db, dev.device_id)
        last_hw_ts = _naive(last_hw.ts) if last_hw else None

        # 实测有值的通道（硬件推过的）
        hw = sorted(hardware_channels(dev.device_id))
        hardware_marked = bool(row and not row.is_virtual)
        # 近 24h 上报条数（只算真实推送）
        n24 = db.execute(
            select(func.count()).select_from(SensorReading)
            .where(SensorReading.device_id == dev.device_id,
                   SensorReading.source == "hardware",
                   SensorReading.ts >= _since(24))
        ).scalar_one()

        # 通信状态**只能看硬件推送**：模拟/补齐行天天在写，拿它们判"在线"
        # 会把没有物理链路的演示点也说成在线（实测踩到过：5 台全显示在线）。
        has_link = hardware_marked or bool(hw)
        if not has_link:
            status, link_age = "no_link", None
        elif last_hw_ts is None:
            status, link_age = "never", None
        else:
            link_age = (now - last_hw_ts).total_seconds() / 60.0
            status = "online" if link_age <= ONLINE_MINUTES else (
                "stale" if link_age <= STALE_HOURS * 60 else "offline")
        data_age = ((now - last_ts).total_seconds() / 60.0) if last_ts else None

        out.append({
            "device_id": dev.device_id,
            "name": dev.name,
            "is_virtual": bool(getattr(dev, "is_virtual", True)),
            "hardware_marked": hardware_marked,
            "token_registered": dev.device_id in reg,
            "mode": dev.mode,
            "station_id": dev.station_id,
            "lon": dev.lon, "lat": dev.lat,
            "declared_channels": list(dev.channels),
            "measured_channels": hw,          # 硬件真正推过的通道
            "missing_channels": [c for c in ALLOWED_CHANNELS if c not in hw],
            # 测距型位移的安装基线（没有基线说明还没收到过有效测距）
            "dist_baseline": (get_baseline(dev.device_id) or {}).get("baseline_mm"),
            "last_ts": last_ts.isoformat() + "Z" if last_ts else None,
            # last_hw_ts = 链路时间；last_ts = 数据时间（含补齐）。两者含义不同，都要给。
            "last_hw_ts": last_hw_ts.isoformat() + "Z" if last_hw_ts else None,
            "link_age_minutes": round(link_age, 1) if link_age is not None else None,
            "last_age_minutes": round(data_age, 1) if data_age is not None else None,
            "status": status,
            "n_24h": int(n24),
        })
    return out


def link_quality(db: Session, device_id: str, hours: int = 72) -> dict:
    """上报时延、断连区间、补传识别 —— 通信链路的体检报告。"""
    rows = _hardware_rows(db, device_id, hours)
    lags, ts_list = [], []
    for r in rows:
        created, ts = _naive(r.created_at), _naive(r.ts)
        if created is None or ts is None:
            continue
        lags.append((ts, (created - ts).total_seconds()))
        ts_list.append(ts)

    if not ts_list:
        return {"device_id": device_id, "hours": hours, "n": 0,
                "note": "该时段没有硬件推送记录（可能未接入硬件，或一直在断线）",
                "delay": {}, "gaps": [], "backfill": {"n": 0, "segments": []}}

    lag_s = pd.Series([v for _, v in lags])
    df = pd.DataFrame({"ts": [t for t, _ in lags], "lag": [v for _, v in lags]})
    hourly = df.set_index("ts")["lag"].resample("h").median().dropna()

    # 断连区间：相邻两条上报的间隔超过常态间隔的 GAP_FACTOR 倍
    ts_sorted = sorted(ts_list)
    deltas = [(ts_sorted[i + 1] - ts_sorted[i]).total_seconds()
              for i in range(len(ts_sorted) - 1)]
    base = float(pd.Series(deltas).median()) if deltas else 0.0
    gaps = []
    if base > 0:
        for i, d in enumerate(deltas):
            if d > base * GAP_FACTOR:
                gaps.append({"from": ts_sorted[i].isoformat() + "Z",
                             "to": ts_sorted[i + 1].isoformat() + "Z",
                             "seconds": round(d, 1)})

    # 补传识别：入库时间比采集时间晚很多
    back = df[df["lag"] > BACKFILL_SECONDS]
    return {
        "device_id": device_id, "hours": hours, "n": len(rows),
        "delay": {
            "p50": round(float(lag_s.median()), 1),
            "p90": round(float(lag_s.quantile(0.9)), 1),
            "max": round(float(lag_s.max()), 1),
            "min": round(float(lag_s.min()), 1),
        },
        "delay_series": [[t.isoformat() + "Z", round(float(v), 1)]
                         for t, v in hourly.items()],
        "normal_interval_s": round(base, 1),
        "gaps": gaps[-20:],
        "backfill": {
            "n": int(len(back)),
            "ratio": round(float(len(back)) / max(1, len(df)), 3),
            "segments": [[t.isoformat() + "Z", round(float(v), 1)]
                         for t, v in zip(back["ts"], back["lag"])][-20:],
        },
    }


def channel_health(db: Session, device_id: str, hours: int = 24) -> list[dict]:
    """逐通道健康度：最后有值时间、24h 条数、卡值、越界。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    out = []
    for ch in ALLOWED_CHANNELS:
        col = getattr(SensorReading, ch)
        last = db.execute(
            select(SensorReading).where(SensorReading.device_id == device_id,
                                        col.isnot(None))
            .order_by(SensorReading.ts.desc()).limit(1)
        ).scalars().first()
        n = db.execute(
            select(func.count()).select_from(SensorReading)
            .where(SensorReading.device_id == device_id, col.isnot(None),
                   SensorReading.ts >= _since(hours))
        ).scalar_one()
        item: dict = {"channel": ch, "n_window": int(n)}
        if last is None:
            item.update({"state": "not_connected", "last_ts": None,
                         "last_value": None, "source": None})
            out.append(item)
            continue
        ts, value = _naive(last.ts), float(getattr(last, ch))
        item.update({
            "last_ts": ts.isoformat() + "Z",
            "last_value": value,
            "source": last.source,
            "age_minutes": round((now - ts).total_seconds() / 60.0, 1),
        })
        lo, hi = RANGES.get(ch, (None, None))
        if (lo is not None and value < lo) or (hi is not None and value > hi):
            item["state"] = "out_of_range"
        else:
            recent = db.execute(
                select(col).where(SensorReading.device_id == device_id,
                                  col.isnot(None))
                .order_by(SensorReading.ts.desc()).limit(STUCK_REPEAT)
            ).scalars().all()
            repeated = (len(recent) == STUCK_REPEAT
                        and len(set(map(float, recent))) == 1)
            benign = BENIGN_REPEAT.get(ch)
            if repeated and benign is not None and float(recent[0]) == benign:
                repeated = False          # 合法常态（如无雨期的 0.0），不算卡值
            item["state"] = "stuck" if repeated else "ok"
        out.append(item)
    return out


def overview(db: Session) -> dict:
    inv = device_inventory(db)
    reg = _registered_tokens()
    n24 = db.execute(
        select(func.count()).select_from(SensorReading)
        .where(SensorReading.source == "hardware", SensorReading.ts >= _since(24))
    ).scalar_one()
    ev24 = db.execute(
        select(func.count()).select_from(IngestEvent)
        .where(IngestEvent.ts >= _since(24))
    ).scalar_one()
    return {
        "devices": len(inv),
        "hardware_devices": sum(1 for d in inv if d["hardware_marked"]),
        "online": sum(1 for d in inv if d["status"] == "online"),
        "stale": sum(1 for d in inv if d["status"] == "stale"),
        "offline": sum(1 for d in inv if d["status"] == "offline"),
        "never": sum(1 for d in inv if d["status"] == "never"),
        "no_link": sum(1 for d in inv if d["status"] == "no_link"),
        "registered_tokens": len(reg),
        "unregistered_tokens": [d["device_id"] for d in inv
                                if not d["token_registered"]],
        "readings_24h": int(n24),
        "ingest_events_24h": int(ev24),
        "storage": storage(db),
    }


def storage(db: Session) -> dict:
    """库体积与增长：`sensor_readings` 只增不减，运维要能看见"涨得多快"。

    只**报告**，不清理 —— 清理是 `scripts/prune_readings.py`，
    而且默认 dry-run、先归档再删（见该脚本说明）。
    """
    n = db.execute(select(func.count()).select_from(SensorReading)).scalar_one()
    first = db.execute(select(func.min(SensorReading.ts))).scalar_one()
    last = db.execute(select(func.max(SensorReading.ts))).scalar_one()
    span_days = None
    per_day = None
    if first and last:
        span_days = max(1e-9, (last - first).total_seconds() / 86400.0)
        per_day = round(n / span_days, 1)

    size_mb = None
    url = settings.database_url
    if url.startswith("sqlite:///"):
        p = Path(url.replace("sqlite:///", ""))
        try:
            size_mb = round(p.stat().st_size / 1024 / 1024, 2)
        except OSError:
            size_mb = None
    return {
        "readings_total": int(n),
        "db_size_mb": size_mb,
        "first_ts": _naive(first).isoformat() + "Z" if first else None,
        "last_ts": _naive(last).isoformat() + "Z" if last else None,
        "span_days": round(span_days, 1) if span_days else None,
        "readings_per_day": per_day,
        "note": "只报告不清理；清理用 scripts/prune_readings.py（默认 dry-run，先归档再删）",
    }


def events(db: Session, limit: int = 50) -> list[dict]:
    rows = db.execute(
        select(IngestEvent).order_by(IngestEvent.ts.desc()).limit(max(1, min(limit, 200)))
    ).scalars().all()
    out = []
    for e in rows:
        ts = _naive(e.ts)
        out.append({
            "device_id": e.device_id,
            "ts": ts.isoformat() + "Z" if ts else None,
            "accepted": e.accepted, "duplicated": e.duplicated,
            "remote": e.remote or "—",
        })
    return out


def security(db: Session) -> dict:
    """令牌与接入安全：**只看"登记/未登记"和"用过没有"，绝不返回令牌原文**。

    回答三件运维真正关心的事：
      * 哪些设备登记了令牌、最后一次用它上报是什么时候、从哪个出口 IP 来的；
      * 来源 IP 变过没有 —— 设备换网/换卡/走不同出口，这是最直接的线索；
      * 当前生效的安全策略是什么（防枚举、失败锁定、令牌轮换怎么做）。
    """
    reg = _registered_tokens()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    items = []
    for dev in manager.all():
        evs = db.execute(
            select(IngestEvent).where(IngestEvent.device_id == dev.device_id)
            .order_by(IngestEvent.ts.desc()).limit(200)
        ).scalars().all()
        hosts: dict[str, list[datetime]] = {}
        for e in evs:
            ip = (e.remote or "").strip()
            if not ip:
                continue
            ts = _naive(e.ts)
            hosts.setdefault(ip, []).append(ts)
        seen = [{"remote": ip, "n": len(v),
                 "first": min(v).isoformat() + "Z", "last": max(v).isoformat() + "Z"}
                for ip, v in hosts.items()]
        seen.sort(key=lambda x: x["last"], reverse=True)
        last = _naive(evs[0].ts) if evs else None
        items.append({
            "device_id": dev.device_id,
            "name": dev.name,
            "token_registered": dev.device_id in reg,
            "last_ingest_ts": last.isoformat() + "Z" if last else None,
            "last_age_minutes": round((now - last).total_seconds() / 60.0, 1) if last else None,
            "last_remote": seen[0]["remote"] if seen else None,
            "sources": seen[:5],
            "source_changed": len(seen) > 1,
            # 接入审计表是 2026-09-23 才建立的，之前的推送没有记录 ——
            # 别把"这张表里没有"说成"这台设备从未上报"（那是两回事）。
            "audit_since": "2026-09-23",
        })
    from services.security import LOCK_SECONDS, MAX_FAILURES          # noqa: PLC0415
    return {
        "tokens": items,
        "registered_count": sum(1 for i in items if i["token_registered"]),
        "policy": {
            "device_auth": "请求头 X-Device-Token（每台设备一个令牌，可单独吊销）",
            "anti_enumeration": "未知设备与错误令牌返回同码同文案的 401，避免探测哪些设备号已登记",
            "login_lock": {"max_failures": MAX_FAILURES, "lock_seconds": LOCK_SECONDS,
                           "scope": "按「来源 IP + 用户名」记账，避免一个人输错把所有人锁掉"},
            "jwt_expire_minutes": settings.jwt_expire_minutes,
            "admin_entry": "管理人员密钥入口" + ("（已配置）" if settings.admin_key else "（未配置）"),
            "token_rotation": "删除 .env 里对应的 <device>:<token> 对并重启服务，旧令牌立即失效",
        },
        # 注意：这是**给用户看的文案**，不能带 Markdown 标记（前端按纯文本渲染）
        "note": "本页只显示令牌的登记状态与使用痕迹，不显示令牌原文。",
    }


def system(db: Session) -> dict:
    """系统运行态与维护：进程、磁盘、库、备份、模型、日志。"""
    import platform
    import shutil
    import sys

    app_dir = Path(__file__).resolve().parents[2]          # .../sentinel-web
    now = datetime.now(timezone.utc)

    def proc(name: str) -> dict:
        pid_file = app_dir / name
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
            # 进程存活判断：/proc 存在即可（Linux）
            alive = Path(f"/proc/{pid}").is_dir()
            started = None
            try:
                started = datetime.fromtimestamp(
                    Path(f"/proc/{pid}").stat().st_ctime, timezone.utc)
            except OSError:
                pass
            return {"pid": pid, "alive": alive,
                    "uptime_hours": round((now - started).total_seconds() / 3600, 2)
                    if started else None}
        except (OSError, ValueError):
            return {"pid": None, "alive": False, "uptime_hours": None}

    backups = []
    bdir = app_dir / "backups"
    if bdir.is_dir():
        for f in sorted(bdir.glob("sentinel_*.tar.gz"), reverse=True)[:7]:
            backups.append({"file": f.name,
                            "mb": round(f.stat().st_size / 1024 / 1024, 2),
                            "ts": datetime.fromtimestamp(f.stat().st_mtime, timezone.utc)
                            .isoformat()[:19] + "Z"})

    models = []
    mdir = Path(settings.model_dir)
    if mdir.is_dir():
        for f in sorted(mdir.iterdir()):
            if f.is_file():
                models.append({"file": f.name,
                               "kb": round(f.stat().st_size / 1024, 1),
                               "ts": datetime.fromtimestamp(f.stat().st_mtime, timezone.utc)
                               .isoformat()[:19] + "Z"})

    logs = []
    for f in sorted(app_dir.glob("app.log*"))[-4:]:
        logs.append({"file": f.name, "mb": round(f.stat().st_size / 1024 / 1024, 2),
                     "ts": datetime.fromtimestamp(f.stat().st_mtime, timezone.utc)
                     .isoformat()[:19] + "Z"})

    d = shutil.disk_usage(str(app_dir))
    return {
        "processes": {"app": proc("run.pid"), "tunnel": proc("tunnel.pid")},
        "disk": {"total_gb": round(d.total / 1024 ** 3, 1),
                 "used_gb": round(d.used / 1024 ** 3, 1),
                 "free_gb": round(d.free / 1024 ** 3, 1),
                 "used_pct": round(d.used / d.total * 100, 1)},
        "storage": storage(db),
        "backups": backups,
        "models": models,
        "logs": logs,
        "runtime": {"python": sys.version.split()[0],
                    "platform": platform.platform(),
                    "tz": settings.tz if hasattr(settings, "tz") else ""},
        "maintenance": {"prune": "scripts/prune_readings.py（默认 dry-run，先归档再删）",
                        "backup": "cron 每天 03:30 执行 backend/scripts/backup.sh，保留 7 份"},
    }


def notify_status(db: Session, limit: int = 50) -> dict:
    """通知与派发：渠道配置状态 + 最近的派发结果（**不显示 webhook 地址**）。"""
    from urllib.parse import urlparse

    from database import NotifyEvent

    url = settings.alert_webhook_url or ""
    host = urlparse(url).hostname if url else None
    rows = db.execute(
        select(NotifyEvent).order_by(NotifyEvent.ts.desc()).limit(max(1, min(limit, 200)))
    ).scalars().all()
    items = []
    for e in rows:
        ts = _naive(e.ts)
        items.append({"ts": ts.isoformat() + "Z" if ts else None,
                      "device_id": e.device_id, "action": e.action, "level": e.level,
                      "kind": e.kind, "ok": bool(e.ok), "detail": e.detail})
    ok_n = sum(1 for i in items if i["ok"])
    return {
        "configured": bool(url),
        "kind": settings.alert_webhook_kind or "wecom",
        "host": host,                       # 只给主机名，地址里的密钥不外泄
        "min_level": settings.alert_notify_min_level,
        "queue_size": __import__("services.notify", fromlist=["queue_size"]).queue_size(),
        "recent": items,
        "recent_ok": ok_n,
        "recent_fail": len(items) - ok_n,
        "hint": ("未配置 webhook：告警只落库、只上大屏，不会外发。"
                 "在 backend/.env 里加 ALERT_WEBHOOK_URL / ALERT_WEBHOOK_KIND，"
                 "再用 scripts/notify_test.py 自检。" if not url else
                 "渠道已配置；可用 scripts/notify_test.py 发一条自检消息。"),
    }


def completeness(db: Session, hours: int = 72) -> dict:
    """数据完整性：来源构成、通道覆盖矩阵、上报缺口区间。"""
    since = _since(hours)
    out_items = []
    for dev in manager.all():
        rows = db.execute(
            select(SensorReading).where(SensorReading.device_id == dev.device_id,
                                        SensorReading.ts >= since)
            .order_by(SensorReading.ts)
        ).scalars().all()
        hw = sum(1 for r in rows if r.source == "hardware")
        sim = len(rows) - hw
        ts = [_naive(r.ts) for r in rows]
        # 缺口：相邻读数间隔超过 30 分钟
        gaps = []
        for a, b in zip(ts, ts[1:]):
            d = (b - a).total_seconds()
            if d > 1800:
                gaps.append({"from": a.isoformat() + "Z", "to": b.isoformat() + "Z",
                             "minutes": round(d / 60, 1)})
        # 通道覆盖矩阵：窗口内该通道有没有值
        cover = {}
        for ch in ALLOWED_CHANNELS:
            vals = [getattr(r, ch) for r in rows]
            n = sum(1 for v in vals if v is not None)
            cover[ch] = {"n": n, "ratio": round(n / len(rows), 3) if rows else 0.0}
        out_items.append({
            "device_id": dev.device_id, "name": dev.name,
            "rows": len(rows), "hardware": hw, "simulation": sim,
            "hardware_ratio": round(hw / len(rows), 3) if rows else 0.0,
            "channels": cover, "gaps": gaps[-10:], "gap_count": len(gaps),
        })
    return {"hours": hours, "items": out_items,
            "note": "缺口判据：相邻读数间隔 > 30 分钟（按该设备自己的采样节奏看）。"}


def selfcheck(device_id: str, base_url: str = "") -> dict:
    """接入自检向导：把硬件同学要的东西一次给全（**不含令牌原文**）。"""
    dev = manager.get(device_id)
    token_ok = device_id in _registered_tokens()
    base = (base_url or "").rstrip("/")
    return {
        "device_id": device_id,
        "known": dev is not None,
        "name": dev.name if dev else None,
        "declared_channels": list(dev.channels) if dev else [],
        "token_registered": token_ok,
        "base_url": base,
        # 直接给**拼好的完整地址**，且不带方法前缀 ——
        # 前端会自己加 curl / POST，之前这里塞了 "GET  {base}/..."，
        # 结果页面上出现 `curl ... "GET {base}/api/..."` 与 `POST POST {base}/...`
        # （占位符没替换 + 方法词重复，动态检查时才暴露出来）。
        "endpoints": {
            "check": f"{base}/api/ingest/check?device_id={device_id}",
            "push": f"{base}/api/ingest/readings",
        },
        "headers": {"Content-Type": "application/json",
                    "X-Device-Token": "<你的设备令牌>"},
        "sample": {
            "device_id": device_id,
            "ts": "<YYYY-MM-DD HH:MM:SS，北京时间>",
            # DIST 给一个**有效**示例值：0 会被判成"没打到目标"（见 ingest.DIST_MIN_VALID），
            # 拿 0 当例子会让硬件同学照着填、然后全部被丢。
            "channels": {c: (890.0 if c == "DIST" else 0.0)
                         for c in (dev.channels if dev else ALLOWED_CHANNELS)},
        },
        "notes": [
            "时间戳按北京时间解析（不带时区时按 UTC+8 处理），别传 UTC。",
            "批量补传用 items 数组；同一 (device_id, ts) 重复推不会写重。",
            "未接入的通道可以省略，不要用 0 冒充。",
            "RN 是雨量感应强度 %（0–100，平面雨量传感器测的是表面湿润程度，"
            "不是累计雨量）；毫米雨量走 RNM 通道。",
            "位移模块报的是**原始测距** DIST（mm，约 900）：我们按 `位移 = 基线 − DIST` "
            "换算成 D，基线取第一次有效测距（可在运维页重新标定）；"
            "没打到目标时请**省略 DIST**，不要报几十毫米的无效值。",
        ],
    }
