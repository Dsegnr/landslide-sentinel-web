"""Read-only, bounded quality view. Sample time is distinct from network reception."""
from datetime import datetime, timezone
from sqlalchemy import DateTime, Integer, case, cast, func, select
from sqlalchemy.orm import Session
from database import SensorReading
from services.telemetry import CHANNELS, _iso, _number, reception_history


def quality(db: Session, device_id: str, hours=24, anchor='latest', end=None):
    history = reception_history(db, device_id, hours, anchor, end)
    start = datetime.fromisoformat(history['start'].replace('Z', '+00:00')).replace(tzinfo=None)
    stop = datetime.fromisoformat(history['end'].replace('Z', '+00:00')).replace(tzinfo=None)
    window = (SensorReading.device_id == device_id, SensorReading.ts >= start, SensorReading.ts < stop)
    hardware = (*window, SensorReading.source == 'hardware')
    sources = [{'source': source or 'unknown', 'count': int(n)} for source, n in db.execute(
        select(SensorReading.source, func.count()).where(*window).group_by(SensorReading.source))]
    dialect = db.get_bind().dialect.name
    def epoch(col):
        if dialect == 'sqlite': return (func.julianday(col) - 2440587.5) * 86400
        if dialect == 'postgresql': return func.extract('epoch', col)
        return func.unix_timestamp(col)
    lag = epoch(SensorReading.created_at) - epoch(SensorReading.ts)
    valid = case((lag >= 0, lag), else_=None)
    n, mean, maximum, negative, late = db.execute(select(
        func.count(valid), func.avg(valid), func.max(valid),
        func.sum(case((lag < 0, 1), else_=0)), func.sum(case((lag > 300, 1), else_=0)),
    ).where(*hardware)).one()
    bucket = cast((epoch(SensorReading.ts) - start.replace(tzinfo=timezone.utc).timestamp()) / history['bucket_seconds'], Integer)
    delay_series = []
    for idx, value in db.execute(select(bucket, func.avg(valid)).where(*hardware).group_by(bucket).order_by(bucket)):
        if 0 <= idx < len(history['bins']): delay_series.append([history['bins'][idx]['ts'], _number(value)])
    # A gap in sample timestamps is not proof of a dropped network connection.
    ordered = select(SensorReading.ts.label('ts'), func.lag(SensorReading.ts, type_=DateTime).over(order_by=SensorReading.ts).label('prev')).where(*hardware).subquery()
    delta = epoch(ordered.c.ts) - epoch(ordered.c.prev)
    gaps_filter = delta > 1800.001
    gap_count = db.scalar(select(func.count()).select_from(ordered).where(gaps_filter))
    gaps = [{'from': _iso(prev), 'to': _iso(ts), 'minutes': round(float(seconds) / 60, 1)} for ts, prev, seconds in db.execute(
        select(ordered.c.ts, ordered.c.prev, delta).where(gaps_filter).order_by(ordered.c.ts.desc()).limit(20))]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    ranges = {'R': (-180, 180), 'P': (-180, 180), 'H': (0, 100), 'RN': (0, 100), 'S': (0, 100), 'RNM': (0, None), 'DIST': (0, None)}
    channels = []
    for j, ch in enumerate(CHANNELS):
        col = getattr(SensorReading, ch)
        recent = db.execute(select(SensorReading.ts, col).where(SensorReading.device_id == device_id,
            SensorReading.source == 'hardware', col.isnot(None)).order_by(SensorReading.ts.desc()).limit(5)).all()
        value = _number(recent[0][1]) if recent else None
        ts = recent[0][0] if recent else None
        lo, hi = ranges.get(ch, (None, None))
        out_of_range = value is not None and ((lo is not None and value < lo) or (hi is not None and value > hi))
        channels.append({'channel': ch, 'last_ts': _iso(ts), 'value': value,
            'age_minutes': max(0, round((now - ts).total_seconds()/60, 1)) if ts else None,
            'count': sum(b['counts'][j] for b in history['heat']),
            'out_of_range': out_of_range, 'repeated': len(recent) == 5 and len({r[1] for r in recent}) == 1})
    return {'history': history, 'sources': sources,
        'delay': {'n': int(n), 'mean': _number(mean), 'max': _number(maximum), 'negative': int(negative or 0), 'late': int(late or 0)},
        'delay_series': delay_series, 'gaps': gaps, 'gap_count': int(gap_count or 0), 'channels': channels}
