"""§50 公開部署防護：rate limit（含 X-Forwarded-For）、Origin、body 上限、health 停擺 503。"""
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from apps.factory_backend import guard, main  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        c.post("/api/simulation/pause")
        yield c


def test_rate_limiter_window_and_gc():
    now = [1000.0]
    rl = guard.RateLimiter({"mutate": (3, 60)}, clock=lambda: now[0])
    assert all(rl.check("mutate", "ip1")[0] for _ in range(3))
    ok, wait = rl.check("mutate", "ip1")
    assert not ok and 0 < wait <= 60
    assert rl.check("mutate", "ip2")[0]                  # 不同 client 不互相影響
    now[0] += 61
    assert rl.check("mutate", "ip1")[0]                  # 視窗滑過 → 恢復
    now[0] += 700
    assert rl.gc() >= 1                                   # 閒置 key 回收


def test_client_key_xff_mode():
    """Render 把真實 client 放在 X-Forwarded-For 第一段 → 預設取 first；
    last／none 可設定。"""
    h = {"x-forwarded-for": "1.1.1.1, 10.0.0.9"}
    assert guard.client_key(h, "127.0.0.1") == "1.1.1.1"                 # 預設 first
    assert guard.client_key(h, "127.0.0.1", mode="first") == "1.1.1.1"
    assert guard.client_key(h, "127.0.0.1", mode="last") == "10.0.0.9"
    assert guard.client_key(h, "127.0.0.1", mode="none") == "127.0.0.1"
    assert guard.client_key({}, "127.0.0.1") == "127.0.0.1"
    assert guard.client_key({"x-forwarded-for": " , "}, "9.9.9.9") == "9.9.9.9"


def test_rate_limit_rest(client, monkeypatch):
    monkeypatch.setattr(guard, "RATE_LIMIT_ON", True)
    monkeypatch.setitem(guard.limiter.limits, "mutate", (2, 60))
    guard.limiter._hits.clear()
    hdr = {"X-Forwarded-For": "203.0.113.7"}
    assert client.post("/api/simulation/pause", headers=hdr).status_code == 200
    assert client.post("/api/simulation/pause", headers=hdr).status_code == 200
    r = client.post("/api/simulation/pause", headers=hdr)
    assert r.status_code == 429 and "retry" in r.json()["detail"]
    # GET 不受限
    assert client.get("/api/health", headers=hdr).status_code == 200
    guard.limiter._hits.clear()


def test_origin_check(client, monkeypatch):
    monkeypatch.setenv("TWIN_CORS_ORIGINS", "https://twin.example.com")
    monkeypatch.delenv("TWIN_ALLOW_NO_ORIGIN", raising=False)
    guard.limiter._hits.clear()
    assert client.post("/api/simulation/pause", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/simulation/pause").status_code == 403          # 有名單時無 Origin 預設拒
    monkeypatch.setenv("TWIN_ALLOW_NO_ORIGIN", "1")
    assert client.post("/api/simulation/pause").status_code == 200
    assert client.post("/api/simulation/pause", headers={"Origin": "https://twin.example.com"}).status_code == 200
    assert client.get("/api/health", headers={"Origin": "https://evil.example"}).status_code == 200
    guard.limiter._hits.clear()


def test_origin_default_is_same_origin(client, monkeypatch):
    """§53：未設 TWIN_CORS_ORIGINS 時不再全放行——同源或無 Origin 才可 POST；
    跨站 Origin／Sec-Fetch-Site cross-site 一律 403（WebSocket 同規則，見 test_ws_guard）。"""
    monkeypatch.delenv("TWIN_CORS_ORIGINS", raising=False)
    guard.limiter._hits.clear()
    assert guard.origin_allowed(None, "twin.example.com") is True
    assert guard.origin_allowed("https://twin.example.com", "twin.example.com") is True
    assert guard.origin_allowed("HTTPS://Twin.Example.com", "twin.example.com") is True
    assert guard.origin_allowed("https://evil.example", "twin.example.com") is False
    assert guard.origin_allowed("null", "twin.example.com") is False
    assert guard.origin_allowed("https://twin.example.com", "twin.example.com", "cross-site") is False
    assert guard.origin_allowed("https://sub.twin.example.com", "twin.example.com", "same-site") is False
    assert guard.origin_allowed("http://localhost:5173", "localhost:5173") is True     # vite dev proxy
    # 反向代理改寫 Host：X-Forwarded-Host 優先（vite xfwd／Render）
    assert guard.request_host({"host": "localhost:8000", "x-forwarded-host": "localhost:5173"}) \
        == "localhost:5173, localhost:8000"
    assert guard.origin_allowed("http://localhost:5173", "localhost:5173, localhost:8000") is True
    assert guard.origin_allowed("http://localhost:9999", "localhost:5173, localhost:8000") is False
    # 走完整 middleware：TestClient 的 Host 是 testserver
    assert client.post("/api/simulation/pause", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/simulation/pause", headers={"Origin": "http://testserver"}).status_code == 200
    assert client.post("/api/simulation/pause").status_code == 200
    guard.limiter._hits.clear()


def test_ws_guard(client, monkeypatch):
    """§53：WebSocket 在 accept 前檢查 Origin；每 IP／總連線數上限；超大上行訊息關閉。"""
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.delenv("TWIN_CORS_ORIGINS", raising=False)
    # 跨站 Origin → 握手被拒（close 1008 → TestClient 以 WebSocketDisconnect 呈現）
    try:
        with client.websocket_connect("/ws", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_text()
        assert False, "cross-site websocket must be rejected"
    except WebSocketDisconnect as ex:
        assert ex.code == 1008
    # 連線上限：每 IP 2
    monkeypatch.setattr(guard.ws_registry, "max_per_ip", 2)
    guard.ws_registry.per_ip.clear(); guard.ws_registry.total = 0
    with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
        a.receive_text(); b.receive_text()
        try:
            with client.websocket_connect("/ws") as c:
                c.receive_text()
            assert False, "third connection from same client must be refused"
        except WebSocketDisconnect as ex:
            assert ex.code == 1013
    assert guard.ws_registry.total == 0                    # 斷線後計數歸零
    # 超大訊息 → 1009
    monkeypatch.setattr(main, "WS_MAX_MSG_BYTES", 64)
    with client.websocket_connect("/ws") as ws:
        ws.receive_text()
        ws.send_text("x" * 200)
        try:
            for _ in range(50):
                ws.receive_text()
            assert False, "oversized message must close the socket"
        except WebSocketDisconnect as ex:
            assert ex.code == 1009
    guard.ws_registry.per_ip.clear(); guard.ws_registry.total = 0


def test_body_size_limit(client, monkeypatch):
    monkeypatch.setattr(guard, "MAX_BODY_BYTES", 1024)
    guard.limiter._hits.clear()
    big = {"failure_type": "conveyor_jam", "target_id": "C-03", "pad": "x" * 4096}
    r = client.post("/api/failures/inject", json=big)
    assert r.status_code == 413
    guard.limiter._hits.clear()


def test_health_stall_rule_and_endpoint(client):
    """停擺判定純函數：非暫停、非重建、超過 STALL_S 未推進 → stalled；
    暫停或重建中不算停擺。端點在正常推進時回 200 ok。"""
    lp = main.HEALTH["last_progress"]
    main.SPEED["paused"] = False; main.RESET["active"] = False
    assert main._stalled(lp + main.STALL_S + 1) is True
    assert main._stalled(lp + main.STALL_S - 1) is False
    main.SPEED["paused"] = True
    assert main._stalled(lp + main.STALL_S + 1) is False
    main.SPEED["paused"] = False; main.RESET["active"] = True
    assert main._stalled(lp + main.STALL_S + 1) is False
    main.RESET["active"] = False
    client.post("/api/simulation/start")
    time.sleep(0.3)
    h = client.get("/api/health").json()
    assert h["status"] == "ok" and "loop_errors" in h and h["layout_id"]
    client.post("/api/simulation/pause")
    guard.limiter._hits.clear()


def test_ws_send_timeout_drops_slow_client(monkeypatch):
    """§53：單一慢連線的 send 逾時 → 回傳 False（呼叫端丟棄），不拖住其他訪客；正常連線照送。
    （真 uvicorn 路徑；TestClient 內以 TWIN_WS_SEND_TIMEOUT_S=0 關閉，見 conftest）"""
    import asyncio
    monkeypatch.setattr(main, "WS_SEND_TIMEOUT_S", 0.05)

    class Slow:
        async def send_text(self, _p: str) -> None:
            await asyncio.sleep(1.0)

    class Fast:
        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send_text(self, p: str) -> None:
            self.sent.append(p)

    t0 = time.time()
    assert asyncio.run(main._ws_send(Slow(), "x")) is False
    assert time.time() - t0 < 0.5
    f = Fast()
    assert asyncio.run(main._ws_send(f, "y")) is True and f.sent == ["y"]


def test_slow_ws_is_closed_and_registry_released(monkeypatch):
    """§54：send 逾時的連線必須 (a) 移出廣播名單 (b) 釋放 registry 名額
    (c) 真的被關閉；正常連線不受影響；多條慢連線並行送，總耗時 ≈ 一個 timeout。"""
    import asyncio
    monkeypatch.setattr(main, "WS_SEND_TIMEOUT_S", 0.05)
    reg = guard.WsRegistry(max_total=10, max_per_ip=5)
    monkeypatch.setattr(main, "ws_registry", reg)

    class Slow:
        def __init__(self) -> None:
            self.closed = False

        async def send_text(self, _p: str) -> None:
            await asyncio.sleep(1.0)

        async def close(self, code: int = 1000, reason: str = "") -> None:
            self.closed = True

    class Fast(Slow):
        def __init__(self) -> None:
            super().__init__(); self.sent: list[str] = []

        async def send_text(self, p: str) -> None:
            self.sent.append(p)

    slows = [Slow() for _ in range(3)]
    fast = Fast()
    main._clients.clear(); main._WS_KEY.clear()
    for i, ws in enumerate([*slows, fast]):
        assert reg.try_add("probe") is None
        main._clients.add(ws); main._WS_KEY[ws] = "probe"
    assert reg.total == 4 and reg.per_ip == {"probe": 4}

    async def run() -> float:
        t0 = time.time()
        await main._broadcast("x")
        await asyncio.sleep(0.05)          # 讓 _safe_close task 跑
        return time.time() - t0
    elapsed = asyncio.run(run())
    assert elapsed < 0.5, elapsed           # 三條慢連線並行逾時，不是 3 × timeout
    assert fast in main._clients and fast.sent == ["x"]
    assert all(ws not in main._clients for ws in slows)
    assert all(ws.closed for ws in slows)
    assert reg.total == 1 and reg.per_ip == {"probe": 1}   # 名額已釋放（只剩 fast）
    main._clients.clear(); main._WS_KEY.clear()


def test_first_snapshot_send_cannot_freeze_broadcasts(monkeypatch):
    """§55：新連線的首份 snapshot 卡住時，_send_lock 必須在一個 timeout 內釋放，
    其他廣播照常；該連線不得進入名單。"""
    import asyncio
    monkeypatch.setattr(main, "WS_SEND_TIMEOUT_S", 0.05)

    class Slow:
        async def send_text(self, _p: str) -> None:
            await asyncio.sleep(2.0)

    class Fast:
        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send_text(self, p: str) -> None:
            self.sent.append(p)

    main._clients.clear(); main._WS_KEY.clear()
    fast = Fast(); main._clients.add(fast); main._WS_KEY[fast] = "ok"

    async def run() -> tuple[bool, float, float]:
        slow = Slow()
        t0 = time.time()
        reg_task = asyncio.create_task(main._register_client(slow, "x" * 65000))
        await asyncio.sleep(0.01)
        t1 = time.time()
        await main._broadcast("ctl")          # 必須在慢速首送逾時後立刻取得鎖
        t_b = time.time() - t1
        ok = await reg_task
        return ok, t_b, time.time() - t0
    ok, t_broadcast, total = asyncio.run(run())
    assert ok is False                       # 慢連線未註冊
    assert t_broadcast < 0.5, t_broadcast    # 廣播沒有被首份 snapshot 卡住 2 s
    assert fast.sent == ["ctl"] and fast in main._clients
    main._clients.clear(); main._WS_KEY.clear()
