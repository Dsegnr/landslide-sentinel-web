"""二维码：把一段文本渲染成 SVG（给"扫码在手机上打开"用）。

**为什么放后端而不是前端**：前端只多一个 `<img>`，不用往包里塞二维码库 ——
演示环境可能是离线的，包越小、依赖越少越好；生成用 `segno`
（纯 Python、无依赖，与 `_tools/pre_demo_check.py` 同一个库）。

**安全**：需要登录；`text` 只当作**纯文本**编码，既不解析也不去取远程资源；
长度上限 512 字符，超了直接 422 —— 免得这个接口被当成免费的二维码生成服务刷。

**两个端点的分工（都在本模块）**：
  * `/api/qr/self.svg` —— **公开、零输入**，只编码服务器自己的地址。
    页面上那个"扫码在手机上查看"用的就是它：`<img src>` **带不了 Authorization 头**，
    需要登录的端点在图片标签里必然 401（实测踩过，`naturalWidth=0`）。
    本部署前端与后端同源，服务器自己的地址就是页面地址。
  * `/api/qr.svg?text=` —— **需要登录**，可编码任意文本。
    给"前端与 API 不同源"（`VITE_API_BASE` 指向别处）或以后做分享卡之类的场景留的，
    当前页面没有用它。
"""
from __future__ import annotations

import io

import segno
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from services.auth import Principal, current_principal

router = APIRouter(prefix="/api/qr", tags=["qr"])

MAX_TEXT = 512


def _svg_response(text: str, scale: int) -> Response:
    """把文本渲染成 SVG 并返回。

    **必须用 `save(kind='svg')` 而不是 `svg_inline()`**：后者的产物是给
    "内联进 HTML" 用的，**不带 `xmlns`**；而 `<img src="...svg">` 是按独立
    文档解析的，缺 `xmlns` 会被浏览器直接判为无法渲染 ——
    表现是接口 200、字节数正常、`<img>` 却 `naturalWidth=0`（实测踩到）。
    """
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="svg", scale=scale, border=2,
                                     dark="#0b1c30", light="#ffffff", xmldecl=True)
    return Response(content=buf.getvalue(), media_type="image/svg+xml",
                    headers={"Cache-Control": "no-store"})


@router.get(".svg")
def qr_svg(text: str = Query(..., min_length=1, max_length=MAX_TEXT,
                             description="要编码的文本（通常是当前访问地址）"),
           scale: int = Query(6, ge=1, le=20),
           principal: Principal = Depends(current_principal)) -> Response:
    """返回二维码的 SVG。前端直接 `<img src="/api/qr.svg?text=...">` 即可。

    用 SVG 而不是 PNG：矢量、体积小（约 1KB）、放大不糊，投影上更清楚。
    `Cache-Control: no-store` —— 地址可能变，不能让浏览器拿旧的二维码。
    """
    return _svg_response(text, scale)


@router.get("/self.svg")
def qr_self(request: Request,
            scale: int = Query(6, ge=1, le=20)) -> Response:
    """**公开**端点：只编码服务器自己的地址（**零输入**，不接受任何文本参数）。

    为什么需要它：登录页是**没有登录态**的（展台场景下评委还没登录就要扫码），
    拿不到鉴权头 —— 上面那个需要登录的 `/api/qr.svg` 在这里会 401、二维码显示不出来。

    为什么做成"零输入"而不是"把 text 放开成公开"：零输入保证它**不可能**被
    当作对外的免费二维码生成服务刷；而且这个端点的答案只取决于 Host，
    输出对所有人一样，天然可以缓存。
    """
    url = str(request.base_url).rstrip("/") + "/"
    return _svg_response(url, scale)
