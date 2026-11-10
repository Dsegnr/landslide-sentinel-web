"""Independent in-memory DB; no writes to demo/research assets."""
from __future__ import annotations
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ['DATABASE_URL'] = 'sqlite:///' + (Path(__file__).resolve().parent / 'qa_telemetry_unused.db').as_posix()
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from database import Base, SensorReading, IngestEvent, get_db
from services.telemetry import reception_history


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.t = datetime(2026, 10, 14, 11, 0)

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def sample(self, ts, source='hardware', device='a', **kw):
        self.db.add(SensorReading(device_id=device, ts=ts, source=source, **kw))

    def event(self, ts, accepted=1, duplicated=0, device='a'):
        self.db.add(IngestEvent(device_id=device, ts=ts, accepted=accepted, duplicated=duplicated, remote='qa-local'))

    def test_sources_counts_and_times(self):
        self.sample(self.t, D=10, T=20)
        self.sample(self.t + timedelta(seconds=10), D=11)
        self.sample(self.t + timedelta(seconds=15), 'simulation', D=9999)
        self.sample(self.t, device='other', D=777)
        self.event(self.t + timedelta(minutes=1), accepted=2, duplicated=1)
        self.event(self.t + timedelta(minutes=2), accepted=0, duplicated=2)
        self.event(self.t, device='other', accepted=100)
        self.db.commit()
        result = reception_history(self.db, 'a')
        self.assertEqual(result['summary'], dict(events=2, accepted=2, duplicated=3, samples=2))
        self.assertEqual([p['values']['D'] for p in result['points']], [10, 11])
        self.assertTrue(result['latest_received'].endswith('11:02:00Z'))
        self.assertTrue(result['latest_sample'].endswith('11:00:10Z'))
        self.assertEqual(sum(b['counts'][3] for b in result['heat']), 1)  # T
        self.assertEqual(sum(b['rows'] for b in result['heat']), 2)
        self.assertEqual(result['bins'][-1]['cumulative'], 2)
        before = self.db.scalar(select(func.count()).select_from(SensorReading))
        reception_history(self.db, 'a', channels=('T',))
        self.assertEqual(self.db.scalar(select(func.count()).select_from(SensorReading)), before)

    def test_half_open_timezone_and_empty(self):
        start = self.t - timedelta(hours=1)
        for ts in (start - timedelta(microseconds=1), start, self.t - timedelta(microseconds=1), self.t):
            self.sample(ts, D=1); self.event(ts)
        self.db.commit()
        end = self.t.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=8)))
        r = reception_history(self.db, 'a', anchor='at', end=end)
        self.assertEqual(r['summary']['samples'], 2)
        self.assertEqual(r['summary']['events'], 2)
        self.assertEqual(len(reception_history(self.db, 'missing')['points']), 0)
        self.assertEqual(reception_history(self.db, 'missing')['summary']['events'], 0)
        # Last endpoint is included by the latest anchor's epsilon.
        self.assertEqual(reception_history(self.db, 'a')['summary']['events'], 2)

    def test_large_series_bounded_with_extrema(self):
        for i in range(1305):
            self.sample(self.t + timedelta(seconds=i), D=5000 if i == 600 else i / 10)
        for i in range(65): self.event(self.t + timedelta(seconds=i * 20))
        self.db.commit()
        r = reception_history(self.db, 'a', anchor='at', end=(self.t + timedelta(hours=1)).replace(tzinfo=timezone.utc))
        self.assertEqual(r['summary']['samples'], 1305)
        self.assertEqual(r['aggregation'], 'mean_min_max')
        self.assertLessEqual(len(r['points']), 96)
        self.assertLessEqual(len(r['bins']), 96)
        self.assertEqual(max(p['ranges']['D'][1] for p in r['points']), 5000)
        self.assertEqual(len(r['recent']), 50)
        self.assertEqual(r['summary']['events'], 65)
        self.assertLessEqual(len(reception_history(self.db, 'a', hours=720)['bins']), 96)

    def test_api_validation_and_auth(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routers.ops import router
        from services.auth import current_principal
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[get_db] = lambda: self.db
        client = TestClient(app)
        self.assertEqual(client.get('/api/ops/telemetry/a').status_code, 401)
        app.dependency_overrides[current_principal] = lambda: object()
        for query in ('hours=0', 'hours=721', 'anchor=bad', 'channels=BOGUS', 'channels=D,R,P', 'anchor=at', 'anchor=at&end=2026-10-14T11:00:00'):
            self.assertEqual(client.get('/api/ops/telemetry/a?' + query).status_code, 422, query)
        self.assertEqual(client.get('/api/ops/telemetry/a?channels=R,P').status_code, 200)

if __name__ == '__main__': unittest.main(verbosity=2)
