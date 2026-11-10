"""Bounded, read-only reception charts. Simulation rows never count as hardware."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import ceil, isfinite

from sqlalchemy import Integer, cast, func, select
from sqlalchemy.orm import Session

from database import IngestEvent, SensorReading

CHANNELS = ("D", "R", "P", "T", "H", "RN", "S", "RNM", "DIST")
MAX_POINTS = 1200
MAX_BINS = 96


def _utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _iso(value: datetime | None) -> str | None:
    return _utc(value).isoformat() + "Z" if value else None


def _number(value):
    return float(value) if value is not None and isfinite(float(value)) else None


def reception_history(db: Session, device_id: str, hours: int = 1,
                      anchor: str = "latest", end: datetime | None = None,
                      channels: tuple[str, ...] = ("D",)) -> dict:
    if not 1 <= hours <= 720 or anchor not in ("live", "latest", "at"):
        raise ValueError("无效的时间范围")
    if not channels or len(channels) > 2 or any(ch not in CHANNELS for ch in channels):
        raise ValueError("通道必须为支持的1—2个通道")
    if anchor == "at" and (end is None or end.tzinfo is None):
        raise ValueError("指定结束时间必须带时区")
    event_device = IngestEvent.device_id == device_id
    hardware = (SensorReading.device_id == device_id, SensorReading.source == "hardware")
    latest_received = db.scalar(select(func.max(IngestEvent.ts)).where(event_device))
    latest_sample = db.scalar(select(func.max(SensorReading.ts)).where(*hardware))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if anchor == "latest":
        stop = _utc(latest_received or latest_sample) + timedelta(microseconds=1) if latest_received or latest_sample else now
    else:
        stop = _utc(end) if anchor == "at" else now
    start = stop - timedelta(hours=hours)
    step = max(1, ceil(hours * 3600 / MAX_BINS))
    count = ceil(hours * 3600 / step)
    dialect = db.get_bind().dialect.name

    def bucket(column):
        if dialect == "sqlite":
            epoch = cast(func.strftime("%s", column), Integer)
        elif dialect == "postgresql":
            epoch = func.extract("epoch", column)
        else:
            epoch = func.unix_timestamp(column)
        return cast((epoch - start.replace(tzinfo=timezone.utc).timestamp()) / step, Integer)

    ev_filter = (event_device, IngestEvent.ts >= start, IngestEvent.ts < stop)
    bins = [{"ts": _iso(start + timedelta(seconds=i * step)), "events": 0,
             "accepted": 0, "duplicated": 0, "cumulative": 0} for i in range(count)]
    ev_bucket = bucket(IngestEvent.ts)
    for idx, n, accepted, duplicated in db.execute(select(
        ev_bucket, func.count(), func.sum(IngestEvent.accepted), func.sum(IngestEvent.duplicated),
    ).where(*ev_filter).group_by(ev_bucket)):
        if 0 <= idx < count:
            bins[idx].update(events=int(n), accepted=int(accepted or 0), duplicated=int(duplicated or 0))
    running = 0
    for item in bins:
        running += item["accepted"]
        item["cumulative"] = running
    rows_filter = (*hardware, SensorReading.ts >= start, SensorReading.ts < stop)
    sample_bucket = bucket(SensorReading.ts)
    columns = [getattr(SensorReading, ch) for ch in CHANNELS]
    aggregates = [sample_bucket, func.count(), *[func.count(col) for col in columns]]
    for ch in channels:
        col = getattr(SensorReading, ch)
        aggregates.extend([func.avg(col), func.min(col), func.max(col)])
    grouped = list(db.execute(select(*aggregates).where(*rows_filter).group_by(sample_bucket).order_by(sample_bucket)))
    heat = [{"ts": b["ts"], "rows": 0, "counts": [0] * len(CHANNELS)} for b in bins]
    sample_count = 0
    grouped_points = []
    for row in grouped:
        idx, n = int(row[0]), int(row[1])
        if not 0 <= idx < count:
            continue
        sample_count += n
        heat[idx].update(rows=n, counts=[int(v) for v in row[2:2 + len(CHANNELS)]])
        offset = 2 + len(CHANNELS)
        values, ranges = {}, {}
        for j, ch in enumerate(channels):
            mean, lo, hi = row[offset + 3 * j:offset + 3 * j + 3]
            values[ch] = _number(mean)
            ranges[ch] = [_number(lo), _number(hi)]
        grouped_points.append({"ts": bins[idx]["ts"], "values": values, "ranges": ranges})
    if sample_count <= MAX_POINTS:
        cols = [getattr(SensorReading, ch) for ch in channels]
        rows = db.execute(select(SensorReading.ts, *cols).where(*rows_filter)
                          .order_by(SensorReading.ts, SensorReading.id).limit(MAX_POINTS))
        points = [{"ts": _iso(row[0]), "values": {ch: _number(row[i + 1]) for i, ch in enumerate(channels)},
                   "ranges": {}} for row in rows]
        aggregation = "raw"
    else:
        points, aggregation = grouped_points, "mean_min_max"
    recent = db.scalars(select(IngestEvent).where(*ev_filter).order_by(IngestEvent.ts.desc(), IngestEvent.id.desc()).limit(50)).all()
    return {
        "device_id": device_id, "anchor": anchor, "start": _iso(start), "end": _iso(stop),
        "hours": hours, "bucket_seconds": step, "latest_received": _iso(latest_received),
        "latest_sample": _iso(latest_sample), "summary": {
            "events": sum(b["events"] for b in bins), "accepted": running,
            "duplicated": sum(b["duplicated"] for b in bins), "samples": sample_count,
        }, "bins": bins, "heat": heat, "heat_channels": CHANNELS,
        "channels": channels, "points": points, "aggregation": aggregation,
        "recent": [{"ts": _iso(e.ts), "accepted": e.accepted, "duplicated": e.duplicated,
                    "remote": e.remote or "—"} for e in recent],
    }
