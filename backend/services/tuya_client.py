"""涂鸦云 OpenAPI 异步客户端（移植自 huapo/app/services/tuya_client.py）。

保留原版已验证的部分：
  * HMAC-SHA256 签名（content = client_id + access_token + t + nonce + method + path + body）
  * access_token 获取与刷新，带过期缓存
  * **未配置凭证时自动降级为模拟数据**（保证没有密钥也能开发与演示）

改动：
  * `requests` → `httpx.AsyncClient`（FastAPI 全异步，避免阻塞事件循环）
  * 增加 `fetch_channels()`：把涂鸦 DP 点直接映射成算法侧的 7 通道命名
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import random
import time
import uuid

import httpx

from config import settings

log = logging.getLogger("sentinel.tuya")

# 涂鸦 DP code → 算法侧通道名（与 experiments 的 7 通道一致：R/P/T/H/RN/S/D）
DP_TO_CHANNEL: dict[str, str] = {
    "tilt_angle": "R",      # 倾角（°，原硬件只有单轴倾角，R/P 同源）
    "tilt_angle_p": "P",
    "temperature": "T",     # 温度（℃）
    "humidity": "H",        # 空气湿度（%）
    "rainfall": "RN",       # 雨量（mm）
    "soil_humidity": "S",   # 土壤含水率（%）
    "distance": "D",        # 激光位移（mm）
}


class TuyaError(Exception):
    def __init__(self, code: int | str, msg: str):
        self.code, self.msg = code, msg
        super().__init__(f"TuyaAPI Error [{code}]: {msg}")


class TuyaClient:
    def __init__(self, access_id: str | None = None, access_key: str | None = None,
                 endpoint: str | None = None, timeout: float = 10.0):
        self.access_id = access_id if access_id is not None else settings.tuya_access_id
        self.access_key = access_key if access_key is not None else settings.tuya_access_key
        self.endpoint = (endpoint or settings.tuya_endpoint).rstrip("/")
        self.timeout = timeout
        self._token = ""
        self._refresh = ""
        self._expire_at = 0.0
        self._configured = bool(self.access_id and self.access_key)

    # 签名
    def _sign(self, method: str, path: str, body: str = "", token: str = "",
              t: int | None = None, nonce: str | None = None) -> str:
        t = t or int(time.time() * 1000)
        nonce = nonce or str(uuid.uuid4())
        content = "".join([self.access_id, token, str(t), nonce,
                           method.upper(), path, body])
        return hmac.new(self.access_key.encode(), content.encode(),
                        hashlib.sha256).hexdigest().upper()

    def _headers(self, method: str, path: str, body: str = "", token: str = "") -> dict:
        t = int(time.time() * 1000)
        nonce = str(uuid.uuid4())
        h = {
            "client_id": self.access_id,
            "sign": self._sign(method, path, body, token, t, nonce),
            "sign_method": "HMAC-SHA256",
            "t": str(t),
            "nonce": nonce,
            "Content-Type": "application/json",
            "lang": "zh",
        }
        if token:
            h["access_token"] = token
        return h

    # token
    async def get_token(self) -> str:
        if not self._configured:
            return "mock-token"
        if self._token and time.time() < self._expire_at:
            return self._token
        path = "/v1.0/token"
        async with httpx.AsyncClient(timeout=self.timeout) as cli:
            r = await cli.get(f"{self.endpoint}{path}",
                              headers=self._headers("GET", path),
                              params={"grant_type": 1})
        data = r.json()
        if not data.get("success"):
            raise TuyaError(data.get("code", -1), data.get("msg", "获取 token 失败"))
        res = data["result"]
        self._token = res["access_token"]
        self._refresh = res.get("refresh_token", "")
        # 提前 60 秒过期，避免边界失效
        self._expire_at = time.time() + int(res.get("expire_time", 7200)) - 60
        return self._token

    # 设备数据
    async def get_device_status(self, device_id: str) -> list[dict]:
        """返回 [{'code': 'distance', 'value': 8.5}, ...]（未配置凭证时返回模拟值）。"""
        if not self._configured:
            return self._mock_status(device_id)
        token = await self.get_token()
        path = f"/v1.0/devices/{device_id}/status"
        async with httpx.AsyncClient(timeout=self.timeout) as cli:
            r = await cli.get(f"{self.endpoint}{path}",
                              headers=self._headers("GET", path, token=token))
        data = r.json()
        if not data.get("success"):
            raise TuyaError(data.get("code", -1), data.get("msg", "读取设备状态失败"))
        return data.get("result", [])

    async def get_device_spec(self, device_id: str) -> dict:
        if not self._configured:
            return {"functions": [{"code": c} for c in DP_TO_CHANNEL]}
        token = await self.get_token()
        path = f"/v1.0/devices/{device_id}/specifications"
        async with httpx.AsyncClient(timeout=self.timeout) as cli:
            r = await cli.get(f"{self.endpoint}{path}",
                              headers=self._headers("GET", path, token=token))
        return r.json().get("result", {})

    async def send_device_command(self, device_id: str, commands: list[dict]) -> dict:
        if not self._configured:
            log.info("模拟下发指令 device=%s commands=%s", device_id, commands)
            return {"mock": True, "commands": commands}
        token = await self.get_token()
        path = f"/v1.0/devices/{device_id}/commands"
        payload = json.dumps({"commands": commands}, ensure_ascii=False)
        async with httpx.AsyncClient(timeout=self.timeout) as cli:
            r = await cli.post(f"{self.endpoint}{path}",
                               headers=self._headers("POST", path, payload, token),
                               content=payload)
        return r.json()

    # 通道映射
    async def fetch_channels(self, device_id: str) -> dict[str, float]:
        """把 DP 点映射为算法侧通道名。只返回本设备实际提供的通道。"""
        status = await self.get_device_status(device_id)
        out: dict[str, float] = {}
        for dp in status:
            ch = DP_TO_CHANNEL.get(dp.get("code", ""))
            if ch and isinstance(dp.get("value"), (int, float)):
                out[ch] = float(dp["value"])
        if "R" in out and "P" not in out:
            out["P"] = out["R"]          # 单轴倾角：P 与 R 同源（如实标注）
        return out

    # 模拟数据
    def _mock_status(self, device_id: str) -> list[dict]:
        """物理上合理的模拟值：用于无凭证时跑通全链路与演示。"""
        seed = abs(hash(device_id)) % 9973
        rng = random.Random(seed + int(time.time() // 60))
        base_d = 8.0 + 0.4 * rng.random()
        return [
            {"code": "tilt_angle", "value": round(rng.uniform(0.5, 3.0), 2)},
            {"code": "temperature", "value": round(rng.uniform(12, 28), 1)},
            {"code": "humidity", "value": round(rng.uniform(40, 85), 1)},
            {"code": "soil_humidity", "value": round(rng.uniform(20, 60), 1)},
            {"code": "rainfall", "value": round(max(0.0, rng.gauss(3, 6)), 1)},
            {"code": "distance", "value": round(base_d, 2)},
        ]
