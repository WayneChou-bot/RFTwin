"""§50 公開部署防護層（WareTwin 借鏡）——讓「一份共享模擬」可以安全公開。

- Rate limit（每 client IP、記憶體內、會回收）：改狀態 20/分、AI 10/分、What-if 4/分
  → 429 {"detail": "...retry in N s"}。`TWIN_RATE_LIMIT=0` 關閉（本機開發）。
- Origin 檢查（§53 預設同源）：未設 `TWIN_CORS_ORIGINS` 時只接受無 Origin 或與 Host 同源的 POST；
  設了名單則只接受名單內 Origin（`TWIN_ALLOW_NO_ORIGIN=1` 放行無 Origin）；`Sec-Fetch-Site`
  cross-site／same-site 一律拒。WebSocket 同規則（accept 前檢查）＋連線數上限＋訊息大小＋send 逾時。
- Body 上限：REST 512 KB，以 ASGI receive 層**實際 bytes** 計算（Content-Length 造假／
  chunked 都擋）→ 413。
- Client IP：`X-Forwarded-For` 依 `TWIN_XFF=first|last|none`（預設 first——Render 把真實
  client 放在第一段；自建代理若會覆寫 XFF 才用 last；none = 不信任 XFF）。
GET 一律不受限。所有規則純 ASGI，不用 BaseHTTPMiddleware（才能在 receive 層攔）。
"""
from __future__ import annotations

import json
import os
import time
from collections import deque
from typing import Any, Callable

MAX_BODY_BYTES = int(os.environ.get("TWIN_MAX_BODY_BYTES", str(512 * 1024)))
RATE_LIMIT_ON = os.environ.get("TWIN_RATE_LIMIT", "1") != "0"

# bucket → (次數, 視窗秒)
LIMITS: dict[str, tuple[int, int]] = {"mutate": (20, 60), "ai": (10, 60), "whatif": (4, 60)}
# path 前綴 → bucket（只對 POST 生效）
BUCKET_BY_PATH: list[tuple[str, str]] = [
    ("/api/scenarios", "whatif"), ("/api/energy/whatif", "whatif"),
    ("/api/copilot", "ai"), ("/api/vision", "ai"),
    ("/api/simulation", "mutate"), ("/api/failures", "mutate"), ("/api/safety", "mutate"),
    ("/api/alerts", "mutate"),
]


def bucket_for(path: str) -> str | None:
    for prefix, b in BUCKET_BY_PATH:
        if path.startswith(prefix):
            return b
    return None


class RateLimiter:
    """滑動視窗；每 (bucket, key) 一個 deque；閒置 > 10 分鐘的 key 回收。"""

    def __init__(self, limits: dict[str, tuple[int, int]] | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.limits = limits or LIMITS
        self.clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._last_gc = clock()

    def check(self, bucket: str, key: str) -> tuple[bool, float]:
        """回傳 (允許?, 建議等待秒數)。允許時已記錄本次。"""
        n, window = self.limits[bucket]
        now = self.clock()
        q = self._hits.setdefault((bucket, key), deque())
        while q and now - q[0] >= window:
            q.popleft()
        if len(q) >= n:
            return False, max(0.0, window - (now - q[0]))
        q.append(now)
        if now - self._last_gc > 60:
            self.gc(now)
        return True, 0.0

    def gc(self, now: float | None = None) -> int:
        now = self.clock() if now is None else now
        dead = [k for k, q in self._hits.items() if not q or now - q[-1] > 600]
        for k in dead:
            del self._hits[k]
        self._last_gc = now
        return len(dead)


limiter = RateLimiter()


# X-Forwarded-For 取哪一段取決於反向代理的寫法。Render（我們的部署目標）
# 說明真實 client IP 在**第一段**，最後一段是它自己的代理節點——取最後一段會讓所有訪客
# 共用同一個 bucket。可設定：first（預設，Render／Cloudflare／多數 PaaS）、last
# （自建 nginx 且會覆寫 XFF 的環境）、none（不信任 XFF，直接用 peer）。
XFF_MODE = os.environ.get("TWIN_XFF", "first").strip().lower()


def client_key(headers: dict[str, str], peer: str | None, mode: str | None = None) -> str:
    mode = (mode or XFF_MODE)
    xff = headers.get("x-forwarded-for")
    if xff and mode != "none":
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[0] if mode == "first" else parts[-1]
    return peer or "?"


def _origin_host(origin: str) -> str:
    """'https://a.example:8443' → 'a.example:8443'（小寫；不含 scheme／path）。"""
    o = origin.strip().lower()
    if "://" in o:
        o = o.split("://", 1)[1]
    return o.split("/", 1)[0]


def origin_allowed(origin: str | None, host: str | None = None,
                   sec_fetch_site: str | None = None) -> bool:
    """§53：預設**同源**，不再「未設定即全放行」。
    - `TWIN_CORS_ORIGINS` 有值 → 只接受名單內的 Origin（另掛網域的前端）。
    - 未設定 → 接受：無 Origin（curl／同機工具；瀏覽器的跨站 POST 一定帶 Origin）、
      或 Origin 的 host 等於請求的 Host（同源）。其他一律拒（跨站 fetch 無法幫全部訪客按 Reset）。
    - Fetch Metadata：瀏覽器帶 `Sec-Fetch-Site: cross-site|same-site` 而 Origin 不在明示名單 → 拒
      （擋子網域）。`TWIN_ALLOW_NO_ORIGIN=1` 只影響「有名單」時是否放行無 Origin 的請求。"""
    allowed = [o.strip().lower() for o in os.environ.get("TWIN_CORS_ORIGINS", "").split(",") if o.strip()]
    if origin is not None and origin.strip().lower() in allowed:
        return True
    if sec_fetch_site in ("cross-site", "same-site"):
        return False
    if allowed:
        if origin is None:
            return os.environ.get("TWIN_ALLOW_NO_ORIGIN", "0") == "1"
        return False
    if origin is None or origin.strip().lower() == "null":
        return origin is None                # "null"（sandboxed iframe／file://）視為跨站
    # host 可為 "a:1" 或 "a:1, b:2"（X-Forwarded-Host 鏈）：任一相符即同源
    hosts = [h.strip().lower() for h in (host or "").split(",") if h.strip()]
    return _origin_host(origin) in hosts


def request_host(headers: dict[str, str]) -> str:
    """同源比較用的 host：反向代理（vite dev/preview proxy、Render）改寫 Host 時以
    `X-Forwarded-Host` 為準；否則 Host。兩者以逗號串起，origin_allowed 任一相符即可。
    跨站瀏覽器請求無法自訂 X-Forwarded-Host（CORS preflight 會擋），因此不構成繞過。"""
    xfh = headers.get("x-forwarded-host", "").strip()
    h = headers.get("host", "").strip()
    return ", ".join(x for x in (xfh, h) if x)


# WebSocket 上限（§53）：總連線數與每 IP 連線數；上行訊息大小；慢連線 send 逾時
WS_MAX_TOTAL = int(os.environ.get("TWIN_WS_MAX", "100"))
WS_MAX_PER_IP = int(os.environ.get("TWIN_WS_MAX_PER_IP", "6"))
WS_MAX_MSG_BYTES = int(os.environ.get("TWIN_WS_MAX_MSG_BYTES", "4096"))
WS_SEND_TIMEOUT_S = float(os.environ.get("TWIN_WS_SEND_TIMEOUT_S", "1.0"))


class WsRegistry:
    """每 IP／總連線數計數（純記憶體）。"""

    def __init__(self, max_total: int | None = None, max_per_ip: int | None = None) -> None:
        self.max_total = WS_MAX_TOTAL if max_total is None else max_total
        self.max_per_ip = WS_MAX_PER_IP if max_per_ip is None else max_per_ip
        self.per_ip: dict[str, int] = {}
        self.total = 0

    def try_add(self, key: str) -> str | None:
        """回傳 None = 允許（已計入）；否則回傳拒絕原因。"""
        if self.total >= self.max_total:
            return f"too many connections ({self.max_total})"
        if self.per_ip.get(key, 0) >= self.max_per_ip:
            return f"too many connections from this client ({self.max_per_ip})"
        self.per_ip[key] = self.per_ip.get(key, 0) + 1
        self.total += 1
        return None

    def remove(self, key: str) -> None:
        n = self.per_ip.get(key, 0) - 1
        if n <= 0:
            self.per_ip.pop(key, None)
        else:
            self.per_ip[key] = n
        self.total = max(0, self.total - 1)


ws_registry = WsRegistry()


async def _json_response(send: Any, status: int, body: dict) -> None:
    data = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(data)).encode())]})
    await send({"type": "http.response.body", "body": data})


class GuardMiddleware:
    """純 ASGI middleware：只攔 POST/PUT/DELETE/PATCH；GET／WebSocket 直通。"""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "DELETE", "PATCH"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        if not origin_allowed(headers.get("origin"), request_host(headers), headers.get("sec-fetch-site")):
            await _json_response(send, 403, {"detail": "origin not allowed"})
            return
        path = scope.get("path", "")
        bucket = bucket_for(path) if RATE_LIMIT_ON else None
        if bucket:
            peer = scope.get("client")
            ok, wait = limiter.check(bucket, client_key(headers, peer[0] if peer else None))
            if not ok:
                await _json_response(send, 429, {
                    "detail": f"rate limited ({bucket}) — retry in {wait:.0f} s",
                    "retry_after_sec": round(wait)})
                return
        cl = headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
            await _json_response(send, 413, {"detail": f"body exceeds {MAX_BODY_BYTES // 1024} KB"})
            return
        total = 0
        tripped = False

        async def capped_receive() -> dict:
            nonlocal total, tripped
            msg = await receive()
            if msg["type"] == "http.request":
                total += len(msg.get("body", b""))
                if total > MAX_BODY_BYTES:
                    tripped = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return msg

        responded = False

        async def guarded_send(msg: dict) -> None:
            nonlocal responded
            if tripped and not responded and msg["type"] == "http.response.start":
                responded = True
                await _json_response(send, 413, {"detail": f"body exceeds {MAX_BODY_BYTES // 1024} KB"})
                return
            if tripped and responded:
                return
            await send(msg)
        await self.app(scope, capped_receive, guarded_send)
