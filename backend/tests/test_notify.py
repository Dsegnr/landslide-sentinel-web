"""告警外发通知测试：文案、渠道格式、非阻塞投递、未配置时不外发。

用一个**本地假 webhook 服务**接收请求，验证真的发出去了、格式对不对；
同时验证"未配置 webhook 时只记日志、不报错"，以及"webhook 挂掉不影响告警主流程"。

运行：cd web/backend && python tests/test_notify.py
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import setup  # noqa: E402

setup(__file__)

from services import notify  # noqa: E402

RECEIVED: list[dict] = []


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):                                  # noqa: N802 - http.server 接口
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        try:
            RECEIVED.append(json.loads(body))
        except json.JSONDecodeError:
            RECEIVED.append({"raw": body})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"errcode":0}')

    def log_message(self, *args):                       # 静音
        pass


def _start_stub() -> tuple[HTTPServer, str]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/webhook"


def test_message_format() -> None:
    text = notify.format_message("created", "slope-node-01", 4, "警报", "哨兵=4 通道=disp")
    assert "【新告警】" in text and "slope-node-01" in text and "4" in text, text
    cleared = notify.format_message("cleared", "slope-node-01", 0, "平静", "")
    assert "【告警解除】" in cleared, cleared
    print("文案 -> 新告警/升级/解除三种动作都有明确前缀")


def test_payload_kinds() -> None:
    notify.configure(url=None, kind="wecom")
    assert notify.build_payload("x") == {"msgtype": "text", "text": {"content": "x"}}
    notify.configure(kind="dingtalk")
    assert notify.build_payload("x") == {"msgtype": "text", "text": {"content": "x"}}
    notify.configure(kind="feishu")
    assert notify.build_payload("x") == {"msg_type": "text", "content": {"text": "x"}}
    notify.configure(kind="slack")
    assert notify.build_payload("x") == {"text": "x"}
    notify.configure(kind="generic")
    assert notify.build_payload("x")["source"] == "slope-sentinel"
    print("渠道格式 -> 企业微信 / 钉钉 / 飞书 / Slack / 通用 JSON 五种报文都正确")


def test_not_configured_is_noop() -> None:
    notify.configure(url="", kind="wecom")
    before = notify.queue_size()
    assert notify.notify("created", "dev", 4, "警报", "x") is False
    assert notify.queue_size() == before, "未配置时不该入队"
    print("未配置 webhook -> 只记日志、不入队、不报错")


def test_delivery_to_stub() -> None:
    server, url = _start_stub()
    RECEIVED.clear()
    notify.configure(url=url, kind="wecom")
    try:
        assert notify.notify("escalated", "slope-node-01", 4, "警报",
                             "预警层=4 p30=85.5%") is True
        for _ in range(50):                       # 等后台线程投递
            if RECEIVED:
                break
            time.sleep(0.1)
        assert RECEIVED, "webhook 没收到通知"
        body = RECEIVED[0]
        assert body["msgtype"] == "text" and "【告警升级】" in body["text"]["content"]
        print("投递 -> 后台线程已把「告警升级」发到假 webhook，格式正确")

        # 等级不足不外发（默认阈值 3）
        RECEIVED.clear()
        assert notify.notify("created", "dev", 2, "预警", "低等级") is False
        time.sleep(0.3)
        assert not RECEIVED, "低于阈值不该外发"
        print("阈值 -> 2 级告警不外发（默认阈值 3 级）")
    finally:
        notify.configure(url="", kind="wecom")
        server.shutdown()


def test_webhook_failure_is_silent() -> None:
    """webhook 地址不通时：notify 仍返回 True（已入队），后台只记日志、不抛异常。"""
    notify.configure(url="http://127.0.0.1:9/none", kind="wecom")
    try:
        assert notify.notify("created", "dev", 4, "警报", "x") is True
        time.sleep(1.0)                            # 让它去失败
        print("webhook 不可达 -> 主流程不受影响（只记 warning 日志）")
    finally:
        notify.configure(url="", kind="wecom")


class _RejectHandler(_Handler):
    """HTTP 200 但业务码非 0 —— 企业微信/钉钉/飞书都用这招表示"其实没发出去"。"""

    def do_POST(self):                                  # noqa: N802 - http.server 接口
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"errcode": 40013, "errmsg": "invalid appid"}).encode())


def _start_rejecting_stub() -> tuple[HTTPServer, str]:
    server = HTTPServer(("127.0.0.1", 0), _RejectHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/webhook"


def test_send_now() -> None:
    """`send_now` 是运维脚本用的**同步**发送，返回的成败必须可信。

    常规告警走队列（采集链路不能被网络阻塞），但隧道地址变更、备份失败这类
    脚本几秒就退出，守护线程来不及发就随进程消失，所以那条路径必须同步发送。
    """
    notify.configure(url="", kind="wecom")
    assert notify.send_now("x")[0] is False, "未配置时必须返回失败，不能假装成功"

    server, url = _start_stub()
    try:
        ok, detail = notify.send_now("同步发送测试", url=url)
        assert ok is True, detail
        assert "errcode" in detail, detail
    finally:
        server.shutdown()

    bad, bad_url = _start_rejecting_stub()
    try:
        ok, detail = notify.send_now("业务码失败测试", url=bad_url)
        assert ok is False and "40013" in detail, f"2xx 里的业务码失败没被识别：{detail}"
    finally:
        bad.shutdown()
    notify.configure(url="", kind="wecom")
    print("同步发送 -> 未配置 / 成功 / 业务码非 0 三种情况判断都正确")


def main() -> None:
    test_message_format()
    test_payload_kinds()
    test_not_configured_is_noop()
    test_delivery_to_stub()
    test_webhook_failure_is_silent()
    test_send_now()
    print("告警通知测试通过")


if __name__ == "__main__":
    main()
