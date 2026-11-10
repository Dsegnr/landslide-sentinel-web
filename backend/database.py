"""SQLAlchemy 2.0 数据模型。

表设计对齐 `docs/Web实现计划.md` 第六节；huapo 原有的 TrafficData / ProvinceData /
PersonnelFlowData 三张城市交通大屏遗留表已删除。
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import (Boolean, DateTime, Float, Index, Integer, String, Text,
                        UniqueConstraint, create_engine, event)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from config import settings


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Device(Base):
    """监测设备（对应涂鸦云 device_id）。"""

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    sensor_type: Mapped[str] = mapped_column(String(32), default="")
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    installed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    is_virtual: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class SensorReading(Base):
    """传感器时序读数。通道：R/P/T/H（倾角、温湿度）/ RN 雨量感应 / RNM 降雨量 / S / D。

    `RN` 与 `RNM` 的区别（2026-09-23 定口径，见 web/docs/硬件接入接口说明_v1.md）：
      * `RN`  = **雨量感应强度 %**（0–100）。现场装的是**平面雨量传感器**，它输出的是
        传感器表面的湿润程度，**不是累计雨量**；把它当 mm 记，大屏就会显示
        "今日降雨 85 mm"这种假数（实测踩到过口径混用的风险）。
      * `RNM` = **降雨量 mm**（本采样周期累计值）。留给翻斗式雨量计这类能出 mm 的传感器；
        目前硬件没有这个传感器，这一列由**同口径补齐（模拟）序列**填充，
        来源由 `source` 字段如实标注。
    模型特征里的"降雨"一律只取 `RNM`，绝不把百分比当毫米用。
    """

    __tablename__ = "sensor_readings"
    __table_args__ = (Index("ix_reading_device_ts", "device_id", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    R: Mapped[float | None] = mapped_column(Float, nullable=True)
    P: Mapped[float | None] = mapped_column(Float, nullable=True)
    T: Mapped[float | None] = mapped_column(Float, nullable=True)
    H: Mapped[float | None] = mapped_column(Float, nullable=True)
    RN: Mapped[float | None] = mapped_column(Float, nullable=True)
    RNM: Mapped[float | None] = mapped_column(Float, nullable=True)
    S: Mapped[float | None] = mapped_column(Float, nullable=True)
    D: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 原始测距（mm）：现场用的是激光/ToF 测距模块，报上来的是"传感器到目标物的距离"，
    # **不是位移**。我们按 `D = 基线 − DIST` 换算成累计位移写进上面的 D 列，
    # 原始值留在这一列以便追溯（口径见 web/docs/硬件接入接口说明_v1.md 第二节之三）。
    DIST: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 这条读数**从哪来**：hardware=硬件直连推送的原始值；simulation=同口径补齐序列；
    # unknown=加这一列之前的历史行（回填时判不出来）。答题与论文都要靠它说清"这段是不是真的"。
    source: Mapped[str] = mapped_column(String(16), default="simulation")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class DeviceBaseline(Base):
    """测距型位移的**安装基线**（mm）：`位移 = 基线 − 当前测距`。

    为什么要单独存表、还要落库：基线是"这台设备装好那一刻传感器到目标物的距离"，
    它必须跨重启保持不变，否则每次重启位移都会归零；而且现场允许重新标定（换安装位置、
    换目标物之后要重设）。第一次收到有效测距时自动记下，管理员也可以手动重标。
    """

    __tablename__ = "device_baselines"

    device_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    baseline_mm: Mapped[float] = mapped_column(Float)
    set_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    # 基线怎么来的：auto=首次有效测距自动记；manual=管理员标定
    source: Mapped[str] = mapped_column(String(16), default="auto")
    note: Mapped[str] = mapped_column(Text, default="")


class Prediction(Base):
    """一次推理的完整输出（与论文的双时间尺度融合口径一致）。"""

    __tablename__ = "predictions"
    __table_args__ = (Index("ix_pred_device_ts", "device_id", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    p7: Mapped[float | None] = mapped_column(Float, nullable=True)
    p30: Mapped[float | None] = mapped_column(Float, nullable=True)
    sentinel_level: Mapped[int] = mapped_column(Integer, default=0)
    sentinel_channels: Mapped[str] = mapped_column(String(64), default="")
    forecast_level: Mapped[int] = mapped_column(Integer, default=0)
    combined_level: Mapped[int] = mapped_column(Integer, default=0)
    stage: Mapped[str] = mapped_column(String(16), default="")
    # 这一行的等级是否**真的算得出来**（近 24 h 有没有可用的位移增量）。
    # False = 数据不足/停更，等级未更新 —— 大屏要显示"数据不足"而不是"平静"，
    # 告警引擎也不能拿它去解除告警。老数据默认 True（它们当年确实算得出）。
    data_available: Mapped[bool] = mapped_column(Boolean, default=True)
    model_version: Mapped[str] = mapped_column(String(32), default="v1")


class Alert(Base):
    """告警记录。status: open / acked / cleared。"""

    __tablename__ = "alerts"
    __table_args__ = (Index("ix_alert_device_ts", "device_id", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    level: Mapped[int] = mapped_column(Integer, default=0)
    stage: Mapped[str] = mapped_column(String(16), default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open")
    acked_by: Mapped[str] = mapped_column(String(64), default="")
    acked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ReservoirLevel(Base):
    """库水位（外部水文数据）。

    为什么单独建表、不塞进 `sensor_readings`：
      * 库水位来自水文站/调度数据，不是我们硬件的传感器通道，量纲与来源都不同；
      * 算法侧的 `draw_7/30/90`（库水位下降速率）与 `level_anom90` 都依赖它，
        但**硬件侧永远拿不到**，混进同一张表会让"设备到底有几个通道"变得含糊；
      * 一旦某天接入真实水文接口，只需要往这张表写，不动硬件通道。

    接入关系：`devices.station_id` -> `reservoir_levels.station_id`（见 device_manager）。
    """

    __tablename__ = "reservoir_levels"
    __table_args__ = (
        Index("ix_level_station_ts", "station_id", "ts"),
        UniqueConstraint("station_id", "ts", name="uq_level_station_ts"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    station_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    level_m: Mapped[float] = mapped_column(Float)
    # 数据来源：demo（模拟）/ csv（本地导入）/ api（外部接口），便于答辩时如实说明
    source: Mapped[str] = mapped_column(String(16), default="demo")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class FieldRecord(Base):
    """现场滑坡记录（队长原版这块只存在浏览器内存里，图片是 blob，刷新就没）。

    这里改成**真正落库 + 照片落盘**：谁在什么时候、哪个点位、什么危险等级、
    附了哪张现场照片，都能查得到、也删不掉历史（审计要求）。
    """

    __tablename__ = "field_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    point_name: Mapped[str] = mapped_column(String(64), index=True)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    level: Mapped[str] = mapped_column(String(16), default="中度")
    note: Mapped[str] = mapped_column(Text, default="")
    # 照片文件名（存 data/uploads/ 下），不放二进制进库
    photo: Mapped[str] = mapped_column(String(128), default="")
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class WarningPoint(Base):
    """地图上的人工警告点位（队长原版只能在页面上"新增记录"，且刷新即丢）。

    与设备节点的区别：
      * `source='manual'`：人工在地图上点的位置，可能是巡检发现的隐患、也可能是临时关注点；
      * **`watch` 关注**：关注的点位在地图上会高亮描边、在列表里置顶（"我盯着它"）；
      * **`weight` 权重**（0.2–3.0）：参与区域加权风险 `weighted_score` 的计算，
        权重越高，这个点位对整体风险的影响越大（例如人工确认过的裂缝点权重 2.0，
        临时标记的观察点权重 0.5）。这样"人工新增"不只是画一个点，而是真的进入风险计算。
    """

    __tablename__ = "warning_points"
    __table_args__ = (Index("ix_point_active", "active"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    lon: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    level: Mapped[int] = mapped_column(Integer, default=2)          # 0~4
    weight: Mapped[float] = mapped_column(Float, default=1.0)        # 0.2~3.0
    watch: Mapped[bool] = mapped_column(Boolean, default=False)      # 是否关注
    note: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(16), default="manual")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class User(Base):
    """账号。role: admin（管理员）/ monitor（监测单位）。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16), default="monitor")
    name: Mapped[str] = mapped_column(String(64), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_email: Mapped[str] = mapped_column(String(128), default="")
    action: Mapped[str] = mapped_column(String(64), default="")
    target: Mapped[str] = mapped_column(String(128), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    ts: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class WeatherCache(Base):
    """天气缓存。

    天气只做"预警权重参比"，所以**永远不让外网接口挡住预警链路**：
    拉回来的结果先落库，之后在缓存窗口内直接用缓存；拉不到就用上一次的结果并标 stale。
    """

    __tablename__ = "weather_cache"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cache_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    payload: Mapped[str] = mapped_column(Text, default="")
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class IngestEvent(Base):
    """一次硬件上报的**接入审计**记录（设备与通信运维页的数据来源）。

    为什么单独记一张表：`sensor_readings` 只回答"值是多少"，回答不了通信侧的问题——
    谁在什么时候推的、推了多少条、重复了多少条、从哪个出口 IP 来的。
    断线补传、链路切换（换网/换卡）、令牌轮换后的首报时刻，都要靠这张表。

    只记**元信息**（条数、去重数、来源 IP），不记令牌原文。
    """

    __tablename__ = "ingest_events"
    __table_args__ = (Index("ix_ingest_dev_ts", "device_id", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)   # 服务器收到的时间
    accepted: Mapped[int] = mapped_column(Integer, default=0)         # 实际写入条数
    duplicated: Mapped[int] = mapped_column(Integer, default=0)       # 幂等去重条数
    remote: Mapped[str] = mapped_column(String(64), default="")       # 来源 IP（链路切换的线索）


class NotifyEvent(Base):
    """一次**告警外发**的结果记录（"通知与派发"页的数据来源）。

    为什么记：通知模块的投递是"失败也不影响主流程"，于是成功与否**只落在日志里**，
    页面上看不到"到底发出去没有、发到哪个渠道、返回了什么"。这张表把它变成可查的记录。
    只记结果与渠道类型，**不记 webhook 地址原文**（地址里含密钥）。
    """

    __tablename__ = "notify_events"
    __table_args__ = (Index("ix_notify_ts", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    action: Mapped[str] = mapped_column(String(16), default="")     # created/escalated/cleared/test
    level: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(16), default="")       # wecom/dingtalk/feishu/...
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    detail: Mapped[str] = mapped_column(String(200), default="")


def _engine_args() -> dict:
    """SQLite 需要关线程检查 + 更大的连接池；MySQL 需要 pre_ping（云库偶发断连）。

    连接池不能太小：`/api/devices` 这类接口在一次请求里会临时再开一个会话
    （读库水位），10 个并发用户就同时占 20 个连接。默认 pool_size=5 + overflow=10
    一超就排队，实测 10 并发从 18ms 掉到 650ms —— 并发能力差就是这个原因。
    """
    if settings.database_url.startswith("sqlite"):
        return {
            "connect_args": {"check_same_thread": False, "timeout": 15},
            "pool_size": 20,
            "max_overflow": 40,
            "pool_timeout": 15,
        }
    return {"pool_pre_ping": True, "pool_recycle": 1800}


def _ensure_dirs() -> None:
    Path(settings.model_dir).mkdir(parents=True, exist_ok=True)
    if settings.database_url.startswith("sqlite"):
        db_path = Path(settings.database_url.replace("sqlite:///", ""))
        db_path.parent.mkdir(parents=True, exist_ok=True)


_ensure_dirs()
engine = create_engine(settings.database_url, echo=False, **_engine_args())
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record) -> None:  # pragma: no cover - 驱动回调
        """SQLite 并发三件套：WAL（读写不互斥）+ NORMAL（少一次 fsync）+ busy_timeout。

        默认的 delete 日志模式 + synchronous=FULL 下，写事务会显式锁库、每次都 fsync；
        多用户同时看大屏时读写互相排队。WAL 下读不会阻塞写、写也不会阻塞读。
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=15000")
        cursor.close()


def _migrate() -> None:
    """轻量迁移：只做"加列 + 回填"，绝不删改既有读数。

    SQLite 没有迁移框架，`create_all` 也不会给已存在的表补列。新增列在这里按需补，
   并且是可重复执行的（先看 PRAGMA 里有没有）。
    """
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(sensor_readings)")}
        if "source" not in cols:
            # SQLite 的 ADD COLUMN 会把已有行填成默认值，所以先加列再按内容回填。
            conn.exec_driver_sql(
                "ALTER TABLE sensor_readings ADD COLUMN source VARCHAR(16) DEFAULT 'simulation'")
            # 回填判据：7 个通道全齐的行只可能是模拟器按同口径生成的；
            # 有明显缺口的行只可能是硬件推上来的（实测就是"只有 T/H"这种）。
            # 这是历史行的一次性推断，之后的新行都由写入方显式声明来源。
            conn.exec_driver_sql(
                "UPDATE sensor_readings SET source = CASE WHEN "
                "R IS NOT NULL AND P IS NOT NULL AND T IS NOT NULL AND H IS NOT NULL "
                "AND RN IS NOT NULL AND S IS NOT NULL AND D IS NOT NULL "
                "THEN 'simulation' ELSE 'hardware' END")

        if "RNM" not in cols:
            # 2026-09-23：把"降雨量 mm"从 RN 拆出来单独占一列。
            # 为什么必须回填而不是留空：RN 原先被当作 mm 雨量喂给预测器
            # （实测 slope-node-01 近 30 日累计 154.92 mm、近 7 日 34.22 mm，
            # 演示点位更大），留空会让模型输入突变、演示的 0–4 级漂掉。
            # 回填后：历史行的数值原样搬到 RNM（那里的 mm 含义不变），
            # RN 保留原值并按"感应强度 %"解释（0–39 的数值作为湿润度是合理的）。
            conn.exec_driver_sql("ALTER TABLE sensor_readings ADD COLUMN RNM FLOAT")
            conn.exec_driver_sql(
                "UPDATE sensor_readings SET RNM = RN WHERE RNM IS NULL AND RN IS NOT NULL")

        if "DIST" not in cols:
            # 2026-09-23：现场位移模块报的是**原始测距 mm**（激光/ToF），不是位移。
            # 原始值单独占一列留存，位移由 `基线 − DIST` 换算后写进 D（见 services/ingest.py）。
            # 历史行没有测距，保持 NULL —— 不去动既有的 D。
            conn.exec_driver_sql("ALTER TABLE sensor_readings ADD COLUMN DIST FLOAT")

        pcols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(predictions)")}
        if "data_available" not in pcols:
            # 历史行默认 1（当年确实算得出等级）；新行由推理链路显式写入。
            conn.exec_driver_sql(
                "ALTER TABLE predictions ADD COLUMN data_available BOOLEAN DEFAULT 1")
            conn.exec_driver_sql("UPDATE predictions SET data_available = 1")


def init_db() -> None:
    Base.metadata.create_all(engine)
    if settings.database_url.startswith("sqlite"):
        _migrate()


def get_db():
    """FastAPI 依赖注入。"""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
