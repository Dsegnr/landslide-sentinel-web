"""设备注册表（移植自 huapo，改为从数据库读 + 内置默认设备）。

设计要点：算法侧需要"位移 + 降雨 + **库水位**"，而硬件（涂鸦）只有 4 类传感器，
**不含库水位**。因此每台设备可关联一个水位站（`station_id`，见 `reservoir_levels` 表），
由它决定该设备能跑哪种预警模式：

  sentinel_only : 只有硬件通道 → 只输出"当下 0~4 级"（哨兵层）
  full          : 硬件通道 + 外部库水位 → 输出双时间尺度融合（哨兵 + 未来 7/30 天）

绑定关系在 `.env` 的 `RESERVOIR_BINDINGS` 里配置（部署配置，不进数据库）。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

log = logging.getLogger("sentinel.devices")


@dataclass
class DeviceInfo:
    device_id: str
    name: str
    channels: list[str] = field(default_factory=list)   # 该设备可提供的算法通道
    station_id: str | None = None                       # 关联的库水位站（接入后才有）
    lon: float | None = None
    lat: float | None = None
    is_virtual: bool = True
    # 演示点专用：固定位移速率（mm/d）。为空时由 `virtual_device.estimate_drift`
    # 按历史估计——但那是"最近 30 天的平均速率"，会把演示点标定好的加速段摊薄
    # （实测：种子给 0.10 mm/d 的 1 级点，十几分钟后就掉回 0 级）。
    # 演示点的等级是**标定出来的场景**，速率必须固定，否则等级会自己漂走。
    drift_mm_per_day: float | None = None

    @property
    def has_level(self) -> bool:
        """是否接入库水位——由"有没有关联水位站"决定，避免两个字段各说各话。"""
        return bool(self.station_id)

    @property
    def mode(self) -> str:
        return "full" if self.has_level else "sentinel_only"


# 默认设备表：涂鸦侧 4 类传感器 + 1 台"复合节点"。”
# 真实 device_id 由队长在涂鸦平台创建后填入 .env 或数据库；
# 未配置时这些虚拟 ID 会走模拟数据，全链路照常可跑。
DEFAULT_DEVICES: dict[str, DeviceInfo] = {
    "slope-node-01": DeviceInfo(
        device_id="slope-node-01",
        name="边坡复合监测节点 01",
        channels=["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"],
        station_id=None,               # 未接库水位（硬件现实）
        lon=110.759, lat=30.983,
    ),
    "slope-node-02": DeviceInfo(
        device_id="slope-node-02",
        name="边坡复合监测节点 02",
        channels=["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"],
        station_id=None,
        lon=110.760, lat=30.982,
    ),
    # ── 演示监测点（2026-09-22 追加，用于分级展示）────────────────────────
    # 为什么要有它们：哨兵层的 1/2/3 级是**加速过程中的过渡态**，
    # 一个自然演化的点要么还在爬、要么已经稳在高位（4 级）、要么一直平稳（0 级），
    # 所以任意时刻只看得到端点。这三个点是**专门做演示用的模拟监测点**，
    # 各自停在自己的变形阶段上，让大屏能同时看到 0/1/2/3/4 五个级别。
    #
    # 诚实口径（答辩时必须照此说）：这三台**全部是模拟数据**，
    # 接口里 `is_demo=true`，前端标注为「演示序列」，与真实硬件节点区分。
    # 级别仍然由算法从模拟序列算出来，不是写死的；速率与对应等级见
    # `scripts/seed_demo_nodes.py` 与 `_tools/calibrate_demo_levels.py` 的实测表。
    "demo-node-01": DeviceInfo(
        device_id="demo-node-01",
        name="演示监测点 A · 平稳",
        channels=["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"],
        station_id=None,
        lon=110.757, lat=30.986,
        drift_mm_per_day=0.02,          # 与平稳段同量级 → 稳定落在 0 级
    ),
    "demo-node-02": DeviceInfo(
        device_id="demo-node-02",
        name="演示监测点 B · 变形初期",
        channels=["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"],
        station_id=None,
        lon=110.763, lat=30.979,
        drift_mm_per_day=0.11,          # 实测稳定落在 1 级
    ),
    "demo-node-03": DeviceInfo(
        device_id="demo-node-03",
        name="演示监测点 C · 变形发展期",
        channels=["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"],
        station_id=None,
        lon=110.755, lat=30.978,
        drift_mm_per_day=0.17,          # 实测稳定落在 2 级
    ),
    # 第 4 个演示点：3 级是"刚越过 z>=5、还没持续够 2 天"的过渡态，
    # 必须由"加速段只留最后 2 天"的形态产生，所以单独一个点。
    "demo-node-04": DeviceInfo(
        device_id="demo-node-04",
        name="演示监测点 D · 加速期",
        channels=["R", "P", "T", "H", "RN", "RNM", "S", "D", "DIST"],
        station_id=None,
        lon=110.752, lat=30.981,
        drift_mm_per_day=0.35,
    ),
}


class DeviceManager:
    def __init__(self, devices: dict[str, DeviceInfo] | None = None):
        self._devices = dict(devices or DEFAULT_DEVICES)

    def all(self) -> list[DeviceInfo]:
        return list(self._devices.values())

    def get(self, device_id: str) -> DeviceInfo | None:
        return self._devices.get(device_id)

    def register(self, info: DeviceInfo) -> None:
        self._devices[info.device_id] = info
        log.info("注册设备 %s（模式=%s）", info.device_id, info.mode)

    def set_level_source(self, device_id: str, station_id: str | None) -> None:
        """设备接入/解绑库水位站后调用，模式自动在 full / sentinel_only 间切换。"""
        if device_id in self._devices:
            self._devices[device_id].station_id = station_id
            log.info("设备 %s 模式 -> %s", device_id, self._devices[device_id].mode)

    def apply_bindings(self, mapping: dict[str, str]) -> None:
        """按配置批量绑定（启动时调用）。未出现在配置里的设备视为不接水位。"""
        for device_id, station_id in mapping.items():
            if device_id in self._devices:
                self.set_level_source(device_id, station_id)
            else:
                log.warning("配置里的设备 %s 未注册，忽略其水位绑定", device_id)


manager = DeviceManager()
