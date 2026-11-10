"""Quality API: isolated SQLite, source clocks, signs, bounds and permissions."""
import os, sys, unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ['DATABASE_URL'] = 'sqlite:///' + (Path(__file__).resolve().parent/'qa_quality_unused.db').as_posix()
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from database import Base, SensorReading, IngestEvent, get_db
from services.ops_quality import quality

class QualityTests(unittest.TestCase):
    def setUp(self):
        self.engine=create_engine('sqlite://',poolclass=StaticPool,connect_args={'check_same_thread':False})
        Base.metadata.create_all(self.engine);self.db=Session(self.engine)
        self.t=datetime(2026,10,14,10,0)
    def tearDown(self):self.db.close();self.engine.dispose()
    def add(self,ts,source='hardware',delay=8,**kw):
        self.db.add(SensorReading(device_id='a',ts=ts,created_at=ts+timedelta(seconds=delay),source=source,**kw))
    def test_source_isolation_signed_values_and_delay(self):
        self.add(self.t,P=-14,D=-10,S=20)
        self.add(self.t+timedelta(minutes=1),delay=12,P=10,D=11)
        self.add(self.t+timedelta(minutes=2),source='simulation',P=999,D=999)
        self.add(self.t+timedelta(minutes=3),source='unknown',D=1)
        self.db.commit()
        r=quality(self.db,'a',1,'at',(self.t+timedelta(hours=1)).replace(tzinfo=timezone.utc))
        self.assertEqual(r['delay']['n'],2);self.assertAlmostEqual(r['delay']['mean'],10,places=3)
        self.assertEqual({s['source']:s['count']for s in r['sources']},{'hardware':2,'simulation':1,'unknown':1})
        self.assertEqual(r['history']['summary']['samples'],2)
        ch={c['channel']:c for c in r['channels']}
        self.assertEqual(ch['P']['value'],10);self.assertFalse(ch['P']['out_of_range']);self.assertFalse(ch['D']['out_of_range'])
        self.assertEqual(ch['RNM']['value'],None)
        self.assertGreater(ch['P']['age_minutes'],30)
    def test_clock_errors_gaps_and_bounds(self):
        self.add(self.t,delay=-10,P=-14,D=-10)
        self.add(self.t+timedelta(minutes=31),delay=350,P=-14,D=-20)
        self.db.commit()
        r=quality(self.db,'a',1,'at',(self.t+timedelta(hours=1)).replace(tzinfo=timezone.utc))
        self.assertEqual(r['delay']['negative'],1);self.assertEqual(r['delay']['n'],1);self.assertEqual(r['delay']['late'],1)
        self.assertAlmostEqual(r['delay']['mean'],350,places=3)
        self.assertEqual(r['gap_count'],1);self.assertEqual(r['gaps'][0]['minutes'],31)
        self.assertTrue(all(not c['out_of_range']for c in r['channels']))
        self.assertLessEqual(len(r['delay_series']),96)
        empty=quality(self.db,'none');self.assertIsNone(empty['delay']['mean']);self.assertEqual(empty['sources'],[])
    def test_large_aggregate_and_no_leading_gap_claim(self):
        for i in range(1300):self.add(self.t+timedelta(seconds=i),delay=10,D=i)
        self.db.commit()
        r=quality(self.db,'a',24,'at',(self.t+timedelta(hours=1)).replace(tzinfo=timezone.utc))
        self.assertEqual(r['history']['summary']['samples'],1300);self.assertEqual(r['gap_count'],0)
        self.assertLessEqual(len(r['history']['points']),96);self.assertLessEqual(len(r['gaps']),20)
    def test_auth_and_validation(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routers.ops import router
        from services.auth import current_principal
        app=FastAPI();app.include_router(router);app.dependency_overrides[get_db]=lambda:self.db;c=TestClient(app)
        self.assertEqual(c.get('/api/ops/quality/a').status_code,401)
        app.dependency_overrides[current_principal]=lambda:object()
        self.assertEqual(c.get('/api/ops/quality/a?hours=0').status_code,422)
        self.assertEqual(c.get('/api/ops/quality/a?anchor=bad').status_code,422)
        self.assertEqual(c.get('/api/ops/quality/a').status_code,200)

if __name__=='__main__':unittest.main(verbosity=2)
