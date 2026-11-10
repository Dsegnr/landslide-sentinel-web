"""告警外发通知（企业微信 / 钉钉 / 飞书机器人 / 通用 webhook / Slack）。

三条硬约束：
  1. **绝不阻塞采集**：投递走后台线程 + 有界队列，队列满就丢最旧；
  2. **失败不影响主流程**：网络异常只记日志，绝不把异常抛回告警引擎；
  3. **默认不外发**：没配 `ALERT_WEBHOOK_URL` 时只记日志（避免演示环境误发到群里）。

配置示例（`.env`）：
  ALERT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
  ALERT_WEBHOOK_KIND=wecom
  ALERT_NOTIFY_MIN_LEVEL=3

`kind` 取值：wecom（企业微信，默认）/ dingtalk（钉钉）/ feishu（飞书）/ slack / generic。
注意几种机器人都把"密钥"放在 URL 里，所以 **URL 属于凭据**：
不要写进命令行参数（会进 shell 历史），用 `.env` 配置；自检用
`python scripts/notify_test.py`，它从 `.env` 读。
"""
from __future__ import annotations

import logging
import queue
import threading
from datetime import datetime, timezone

import httpx

from config import settings

log = logging.getLogger("sentinel.notify")

_queue: "queue.Queue[dict]" = queue.Queue(maxsize=200)
_worker_started = False
_start_lock = threading.Lock()
LEVEL_NAME = {0: "平静", 1: "关注", 2: "预警", 3: "高度预警", 4: "警报"}


def format_message(action: str, device_id: str, level: int, stage: str,
                   reason: str, ts: str | None = None) -> str:
    """人类可读的告警文案（企业微信/Slack 都能直接发）。"""
    verb = {"created": "【新告警】", "escalated": "【告警升级】",
            "cleared": "【告警解除】"}.get(action, "【告警】")
    when = (ts or datetime.now(timezone.utc).isoformat())[:19].replace("T", " ")
    return (f"{verb}{stage or LEVEL_NAME.get(level, '')}（{level} 级）\n"
            f"点位：{device_id}\n依据：{reason or '—'}\n时间：{when} UTC")


def build_payload(text: str) -> dict:
    """按渠道拼请求体。"""
    kind = (settings.alert_webhook_kind or "wecom").lower()
    if kind in ("feishu", "lark"):
        # 飞书自定义机器人：字段名与其它家不同（msg_type + content.text）
        return {"msg_type": "text", "content": {"text": text}}
    if kind == "slack":
        return {"text": text}
    if kind == "generic":
        return {"text": text, "source": "slope-sentinel"}
    # 企业微信与钉钉的文本报文结构相同
    return {"msgtype": "text", "text": {"content": text}}


def configure(url: str | None = None, kind: str | None = None) -> None:
    """运行时改配置（测试用）。"""
    if url is not None:
        settings.alert_webhook_url = url
    if kind is not None:
        settings.alert_webhook_kind = kind


def start_worker() -> None:
    """启动后台投递线程（幂等）。"""
    global _worker_started
    with _start_lock:
        if _worker_started:
            return
        threading.Thread(target=_worker, name="notify-worker", daemon=True).start()
        _worker_started = True
        log.info("告警通知线程已启动（webhook: %s）",
                 "已配置" if settings.alert_webhook_url else "未配置，仅记日志")


def notify(action: str, device_id: str, level: int, stage: str,
           reason: str = "", ts: str | None = None) -> bool:
    """入队一条通知；返回是否真的外发（未配置或等级不够时返回 False）。"""
    text = format_message(action, device_id, level, stage, reason, ts)
    if not settings.alert_webhook_url:
        log.info("（未配置 webhook，仅记录）%s", text.replace("\n", " | "))
        return False
    if action != "cleared" and level < settings.alert_notify_min_level:
        return False
    start_worker()
    item = {"text": text, "action": action, "device_id": device_id, "level": level}
    try:
        _queue.put_nowait(item)
    except queue.Full:
        try:
            _queue.get_nowait()          # 丢最旧的，保证采集侧永不阻塞
        except queue.Empty:
            pass
        try:
            _queue.put_nowait(item)
        except queue.Full:
            log.warning("通知队列已满，丢弃一条告警通知")
            return False
    return True


def record(device_id: str, action: str, level: int, ok: bool, detail: str) -> None:
    """把一次投递结果落库（尽力而为：落库失败绝不影响通知本身）。

    为什么要它：投递成功与否本来只写在日志里，页面上看不到 ——
    "到底发出去没有、发到哪个渠道、返回了什么"应当是能查的。
    只记结果与渠道类型，**不记 webhook 地址**（里面含密钥）。
    """
    try:
        from database import NotifyEvent, SessionLocal

        db = SessionLocal()
        try:
            db.add(NotifyEvent(device_id=device_id, action=action, level=int(level or 0),
                               kind=(settings.alert_webhook_kind or ""),
                               ok=bool(ok), detail=(detail or "")[:200]))
            db.commit()
        finally:
            db.close()
    except Exception:                          # noqa: BLE001 - 记录失败不影响投递
        pass


def _worker() -> None:
    while True:
        item = _queue.get()
        try:
            with httpx.Client(timeout=8) as client:
                resp = client.post(settings.alert_webhook_url,
                                   json=build_payload(item["text"]))
            if resp.status_code >= 300:
                log.warning("告警通知返回 %s：%s", resp.status_code, resp.text[:120])
            else:
                log.info("告警通知已发送：%s", item["device_id"])
            record(item["device_id"], item.get("action", ""), item.get("level", 0),
                   resp.status_code < 300, f"HTTP {resp.status_code} {resp.text[:120]}")
        except Exception as exc:                  # noqa: BLE001 - 外发失败绝不影响主流程
            log.warning("告警通知发送失败：%s", exc)
            record(item["device_id"], item.get("action", ""), item.get("level", 0),
                   False, f"发送失败：{exc}")
        finally:
            _queue.task_done()


def queue_size() -> int:
    """测试用：当前待发条数。"""
    return _queue.qsize()


def send_now(text: str, url: str | None = None,
             kind: str | None = None) -> tuple[bool, str]:
    """**同步**发一条，返回 (是否成功, 渠道原始返回或错误说明)。

    常规告警必须走 `notify()` 的"队列 + 后台线程"，因为采集链路绝不能被网络阻塞。
    但运维脚本（隧道地址变更、备份失败……）几秒就退出，守护线程来不及发就随进程消失，
    所以那条路径需要同步发送。

    这里把"2xx 但业务码非 0"也算失败——企业微信/钉钉/飞书都会这么干：
    HTTP 200，body 里却是 errcode=40013 之类的错误。
    """
    target = url or settings.alert_webhook_url
    if not target:
        return False, "未配置 ALERT_WEBHOOK_URL（告警只落库、只在服务端日志里记录）"
    if kind:
        settings.alert_webhook_kind = kind
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(target, json=build_payload(text))
    except Exception as exc:                      # noqa: BLE001 - 运维路径，返回错误串即可
        record("", "manual", 0, False, f"发送失败：{exc}")
        return False, f"请求发不出去：{exc}"

    body = resp.text.strip()
    if resp.status_code >= 300:
        record("", "manual", 0, False, f"HTTP {resp.status_code} {body[:120]}")
        return False, f"HTTP {resp.status_code}：{body[:200]}"
    compact = body.replace(" ", "")
    for marker in ('"errcode":', '"code":'):
        if marker in compact:
            raw = compact.split(marker, 1)[1].split(",")[0].split("}")[0]
            try:
                code = int(raw)
            except ValueError:
                continue
            if code != 0:
                record("", "manual", 0, False, f"HTTP {resp.status_code} 业务码 {code}")
                return False, f"HTTP {resp.status_code} 但业务码 {code}：{body[:200]}"
    record("", "manual", 0, True, f"HTTP {resp.status_code} {body[:120]}")
    return True, body[:200]
