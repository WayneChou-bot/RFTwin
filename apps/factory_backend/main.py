"""factory-backend — FastAPI + WebSocket（§14、§26；ADR-004）。

啟動：uvicorn apps.factory_backend.main:app --port 8000
啟動時以 seed 42 pre-roll，之後由背景任務以 10 ticks/s ×speed 推進（Live）。
牆鐘只決定「推進節奏」；狀態轉移仍完全由 tick 驅動。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages"))

from contextlib import asynccontextmanager  # noqa: E402

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import PlainTextResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.copilot import SUGGESTED_QUESTIONS, ask, render_nl  # noqa: E402
from domain_factory.explanation import explain_live, explain_scenario  # noqa: E402
from domain_factory.maintenance import assess  # noqa: E402
from domain_factory.serialize import amr_patch_message, snapshot_message  # noqa: E402
from domain_factory.vision import VisionInspector, render_part_image, to_png  # noqa: E402
from domain_factory.whatif import run_energy_scenario, run_scenario, validate_whatif  # noqa: E402
from twin_runtime_core.clock import wall_now_iso  # noqa: E402

from .guard import (WS_MAX_MSG_BYTES, WS_SEND_TIMEOUT_S, GuardMiddleware, client_key, origin_allowed,
                    request_host, ws_registry)  # noqa: E402  §50 公開部署防護

RUNS: dict[str, FactoryEngine] = {}
SPEED = {"value": 1.0, "paused": False, "seq": 0}
RESET = {"active": False}                # §49：Reset 重建中（ticker 凍結舊 run）
AMR_PREV: dict[str, dict] = {}           # §50：amr_patch 上次送出的欄位（run_id → amr_id → fields）
SUPERSEDED: set[str] = set()             # 已被 Reset 取代的 run_id（查詢回 410，不是 404）
_clients: set[WebSocket] = set()
_lock = asyncio.Lock()

@asynccontextmanager
async def lifespan(app):
    eng = FactoryEngine(run_id="LIVE-001", seed=42)
    eng.preroll()
    RUNS["LIVE-001"] = eng
    task = asyncio.create_task(_ticker())
    yield
    task.cancel()


app = FastAPI(title="Robot Factory Digital Twin", version="0.10.2", lifespan=lifespan)
# CORS：本機開發預設放行 vite dev（5173）；部署時以 TWIN_CORS_ORIGINS（逗號分隔）指定前端網域
_origins = [o.strip() for o in os.environ.get("TWIN_CORS_ORIGINS", "http://localhost:5173").split(",")
            if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GuardMiddleware)      # §50：rate limit／Origin／body 上限（純 ASGI）
log = logging.getLogger("twin")
STALL_S = float(os.environ.get("TWIN_HEALTH_STALL_S", "10"))
HEALTH = {"last_progress": time.monotonic(), "loop_errors": 0, "last_error": None}



def _wrap_event(eng: FactoryEngine, ev: dict) -> dict:
    return {"type": "event", "schema_version": eng.provenance["schema_version"],
            "run_id": eng.run_id, "seq": ev["seq"], "sim_tick": ev["sim_tick"],
            "sim_time": ev["sim_time"], "generated_at": wall_now_iso(), "event": ev}


def _control() -> dict:
    """§52：control 帶單調 seq——ticker 已組好但尚未送出的 snapshot（舊控制狀態）可能晚於
    pause 的 control 廣播抵達；前端只接受 seq 不倒退的控制狀態。"""
    return {"paused": SPEED["paused"], "speed": SPEED["value"], "seq": SPEED["seq"]}


def _control_changed() -> None:
    SPEED["seq"] += 1


def _snapshot(eng: FactoryEngine) -> dict:
    """§51：Live snapshot 附控制狀態（paused／speed 以後端為準，多分頁一致）。"""
    m = snapshot_message(eng)
    m["control"] = _control()
    return m


def _control_message(eng: FactoryEngine) -> dict:
    return {"type": "control", "schema_version": eng.provenance["schema_version"],
            "run_id": eng.run_id, "sim_tick": eng.clock.tick, "control": _control()}


_send_lock = asyncio.Lock()   # §52：同一條 WebSocket 不得由 ticker 與 control 廣播同時 send（會互相打斷→連線被丟棄）
_WS_KEY: dict[WebSocket, str] = {}   # §54：ws → registry key（丟棄時釋放名額）


async def _safe_close(ws: WebSocket, code: int = 1011, reason: str = "slow consumer") -> None:
    try:
        async with asyncio.timeout(1.0):
            await ws.close(code=code, reason=reason)
    except Exception:
        pass


def _drop_client(ws: WebSocket, close: bool = True) -> None:
    """§54：丟棄一條連線＝從廣播名單移除 ＋ 釋放 registry 名額 ＋ 真的關閉 socket
    （否則對方仍掛在 receive_text，永久占用總量／每 IP 名額）。冪等；由 finally 與 send 逾時共用。"""
    _clients.discard(ws)
    key = _WS_KEY.pop(ws, None)
    if key is not None:
        ws_registry.remove(key)
    if close:
        log.warning("ws slow consumer dropped: %s (timeout %.1fs)", key, WS_SEND_TIMEOUT_S)
        try:
            asyncio.get_running_loop().create_task(_safe_close(ws))
        except RuntimeError:
            pass


async def _send_all(ws: WebSocket, payloads: list[str]) -> bool:
    """同一條連線依序送（保序）；任一筆逾時／失敗即回 False。"""
    for pl in payloads:
        if not await _ws_send(ws, pl):
            return False
    return True


async def _fanout(payloads: list[str]) -> None:
    """§54：對所有 client **並行**送（每條各自有逾時，總耗時 ≈ 一個 timeout 而非 N 個），
    仍在 _send_lock 內以免 ticker 與 control 廣播在同一條 socket 上交錯。慢連線 → _drop_client。"""
    async with _send_lock:
        clients = list(_clients)
        if not clients or not payloads:
            return
        if WS_SEND_TIMEOUT_S <= 0:      # 測試模式（TestClient 記憶體 WS 不容許把 send 包進 task）→ 依序
            results: list = [await _send_all(ws, payloads) for ws in clients]
        else:
            results = await asyncio.gather(*(_send_all(ws, payloads) for ws in clients),
                                           return_exceptions=True)
        for ws, ok in zip(clients, results):
            if ok is not True:
                _drop_client(ws)


async def _broadcast(payload: str) -> None:
    await _fanout([payload])


async def _register_client(ws: WebSocket, first: str) -> bool:
    """§55：新連線的首份 snapshot（~65 KB）在 _send_lock 內送出以保證「首份 snapshot
    之後才收到廣播」的順序——但必須走 _ws_send 的逾時：慢速／異常的新連線不得凍結 ticker、control
    廣播與所有正常客戶端。逾時 → 不加入名單、回傳 False（呼叫端關閉並釋放名額）。"""
    async with _send_lock:
        if not await _ws_send(ws, first):
            return False
        _clients.add(ws)               # 在鎖內加入：首個 snapshot 之後才會收到廣播（順序保證）
        return True


async def _broadcast_control() -> None:
    eng = RUNS.get("LIVE-001")
    if eng is not None:
        await _broadcast(json.dumps(_control_message(eng)))


async def _ticker() -> None:
    """Live 推進：每 0.1 s 跑 (1 × speed) 個 tick，並廣播新事件；
    每滿 1 s 追加一份完整 snapshot（§14.1：counters 1 Hz；robot 動畫由前端插值）。"""
    cycle = 0
    while True:
        await asyncio.sleep(0.1)
        if SPEED["paused"]:
            continue
        if RESET["active"]:
            continue                     # §49：重建期間舊 run 凍結（不推進、不廣播）
        eng = RUNS.get("LIVE-001")
        if eng is None:
            continue
        cycle += 1
        payloads: list[str] = []
        try:
            async with _lock:
                if RUNS.get("LIVE-001") is not eng:
                    continue             # 等鎖期間已被 Reset 換掉 → 不推進舊 run
                before = eng.bus.seq
                for _ in range(max(1, round(1 * SPEED["value"]))):
                    eng.step()
                new_events, _ = eng.bus.after(before)
                payloads = [json.dumps(_wrap_event(eng, ev)) for ev in new_events]
                # §50：AMR 位置 10 Hz 增量（只帶變動欄位，~300 B）；snapshot 仍每 1 s 一份
                pm = amr_patch_message(eng, AMR_PREV.setdefault(eng.run_id, {}))
                if pm is not None:
                    payloads.append(json.dumps(pm))
                if cycle % 10 == 0:
                    payloads.append(json.dumps(_snapshot(eng)))
            HEALTH["last_progress"] = time.monotonic()
        except asyncio.CancelledError:
            raise
        except Exception as ex:          # §50：單輪失敗不能讓整個模擬死掉（記錄後續行）
            HEALTH["loop_errors"] += 1
            HEALTH["last_error"] = f"{type(ex).__name__}: {ex}"[:300]
            log.exception("ticker error #%d: %s", HEALTH["loop_errors"], HEALTH["last_error"])
            await asyncio.sleep(0.5)
            continue
        if RUNS.get("LIVE-001") is not eng or RESET["active"]:
            continue                     # §49：舊 run 的 payload 不得晚到回寫
        if _clients and payloads:
            await _fanout(payloads)          # §53／§54：並行送、逾時即丟棄並釋放名額


def _run(run_id: str) -> FactoryEngine:
    if run_id not in RUNS:
        if run_id in SUPERSEDED:
            cur = RUNS.get("LIVE-001")
            raise HTTPException(410, f"run {run_id} was superseded by reset; "
                                     f"current live run is {cur.run_id if cur else 'n/a'}")
        raise HTTPException(404, f"run {run_id} not found")
    return RUNS[run_id]


# ---------------------------------------------------------------- REST（§26）

def _stalled(now: float) -> bool:
    """§50 停擺判定（純函數，可測）：非暫停、非重建中、且距上次推進 > STALL_S。"""
    return (not SPEED["paused"] and not RESET["active"]
            and now - HEALTH["last_progress"] > STALL_S)


@app.get("/api/health")
async def health() -> dict:
    """§43.5 前端連線 bootstrap：模式判定與 schema 驗證的第一步。"""
    eng = RUNS.get("LIVE-001")
    if eng is None:
        raise HTTPException(503, "engine warming up (pre-roll)")
    # §50：模擬迴圈停擺（非暫停、非重建中）超過 STALL_S → 503，讓部署平台自動重啟
    stalled = _stalled(time.monotonic())
    body = {"status": "stalled" if stalled else "ok", "run_id": eng.run_id,
            "schema_version": eng.provenance["schema_version"],
            "engine_version": eng.provenance["engine_version"],
            "parameter_set_id": eng.provenance["parameter_set_id"],
            "layout_id": eng.provenance.get("layout_id"),
            "seq": eng.bus.seq, "sim_time": eng.clock.sim_time_iso,
            "resetting": RESET["active"],          # §49：重建中（舊 run 凍結）
            "loop_errors": HEALTH["loop_errors"], "last_error": HEALTH["last_error"]}
    if stalled:
        raise HTTPException(503, body)
    return body


@app.get("/api/runs")
async def runs() -> list[dict]:
    """現役 run（去重：LIVE-001 只是別名，不重複列出）。"""
    seen: list[FactoryEngine] = []
    for e in RUNS.values():
        if all(e is not x for x in seen):
            seen.append(e)
    return [e.provenance for e in seen]


@app.get("/api/runs/{run_id}/snapshot")
async def snapshot(run_id: str) -> dict:
    async with _lock:
        return _snapshot(_run(run_id))


@app.get("/api/runs/{run_id}/events")
async def events(run_id: str, after_seq: int, limit: int = 500) -> dict:
    """seq > after_seq（exclusive），升冪。complete=false 表示超出保留窗口 → 重取 snapshot。"""
    eng = _run(run_id)
    evs, complete = eng.bus.after(after_seq, limit)
    return {"run_id": run_id, "after_seq": after_seq, "complete": complete,
            "events": evs, "latest_seq": eng.bus.seq}


@app.get("/api/kpis")
async def kpis() -> dict:
    return _run("LIVE-001").kpis()


@app.get("/api/robots")
async def robots() -> list[dict]:
    async with _lock:
        return snapshot_message(_run("LIVE-001"))["state"]["robots"]


@app.get("/api/cells")
async def cells() -> list[dict]:
    async with _lock:
        return snapshot_message(_run("LIVE-001"))["state"]["cells"]


@app.get("/api/alerts")
async def alerts() -> list[dict]:
    return _run("LIVE-001").alerts


@app.get("/api/audit")
async def audit(limit: int = 100) -> list[dict]:
    return _run("LIVE-001").audit.entries[-limit:]


@app.post("/api/simulation/pause")
async def pause() -> dict:
    SPEED["paused"] = True
    _control_changed()
    await _broadcast_control()                    # §51：所有分頁同步
    return {"paused": True}


@app.post("/api/simulation/start")
async def start() -> dict:
    SPEED["paused"] = False
    _control_changed()
    HEALTH["last_progress"] = time.monotonic()    # 恢復播放不算停擺
    await _broadcast_control()
    return {"paused": False}


@app.post("/api/simulation/speed")
async def speed(value: float) -> dict:
    SPEED["value"] = max(0.1, min(100.0, value))
    _control_changed()
    await _broadcast_control()
    return {"speed": SPEED["value"]}


@app.get("/api/simulation/control")
async def control() -> dict:
    """§51：控制狀態（分頁回前景／重連時可直接查）。"""
    eng = RUNS.get("LIVE-001")
    return {**_control(), "run_id": eng.run_id if eng else None, "resetting": RESET["active"]}


_live_counter = {"n": 1}                 # LIVE-001 由 lifespan 建立


def _build_live(run_id: str) -> FactoryEngine:
    """建立並 pre-roll 新 live engine（CPU-heavy；於 worker thread 執行）。"""
    eng = FactoryEngine(run_id=run_id, seed=42)
    eng.preroll()
    return eng


@app.post("/api/simulation/reset")
async def reset() -> dict:
    """同 seed 重建確定性 run，回到 10:00 預熱完成起點（shift 06:00 開始、pre-roll 4h；
    §33 驗收 10、§49 語意）。新 run_id；seq 為 pre-roll 後的值（非 0）。
    pre-roll（4–10 s 依硬體）移出 event loop——先在 thread 建好新
    engine，完成後才短暫取 lock 交換 RUNS；期間 ticker／WebSocket／API 照常回應。"""
    if RESET["active"]:
        raise HTTPException(409, "reset already in progress")
    RESET["active"] = True              # §49：重建期間舊 run 凍結（畫面不再「先走再跳回」）
    try:
        async with _lock:
            _live_counter["n"] += 1
            run_id = f"LIVE-{_live_counter['n']:03d}"
        eng = await asyncio.to_thread(_build_live, run_id)
        async with _lock:
            # registry 只保留現役 run（實際 run_id ＋ LIVE-001 別名）；
            # 舊 engine（含完整 history）與其 amr_patch 快取一併釋放，長時間公開 Demo 不累積記憶體
            old_ids = [k for k, e in RUNS.items() if e is not eng]
            for k in old_ids:
                RUNS.pop(k, None)
                AMR_PREV.pop(k, None)
            SUPERSEDED.update(k for k in old_ids if k != "LIVE-001")
            SCENARIOS.clear()           # §53：舊 run 的 what-if 不能 Apply 也不該累積
            RUNS[run_id] = eng
            RUNS["LIVE-001"] = eng      # 別名：目前作用中的 live run
        SPEED["paused"] = False         # Reset 語意 = 回到 10:00 預熱完成起點並運行
        _control_changed()
    finally:
        RESET["active"] = False
        HEALTH["last_progress"] = time.monotonic()    # 重建期間不算停擺
    await _broadcast_control()          # §51：其他分頁得知新 run 已在播放
    return {"run_id": run_id, "provenance": eng.provenance}


# ---------------------------------------------------------------- 故障注入與安全（§19、§20、§26）

@app.post("/api/failures/inject")
async def inject_failure(payload: dict) -> dict:
    """{"failure_type": "conveyor_jam"|"tool_failure"|"minor_stop"
                        |"safety_gate_open"|"amr_fault"|"zone_obstacle"…,
        "target_id": "C-03"|"R-06"|"W-01"|"CELL-WELDING"|"AMR-01"|"corridor_west",
        "duration_sec": 120?, "x"/"z"/"radius"?（zone_obstacle 自訂位置）}"""
    eng = _run("LIVE-001")
    try:
        dur = payload.get("duration_sec")
        if dur is not None:                     # §52：注入時長邊界（1 s–2 h；公開服務不接受「永久」故障）
            dur = float(dur)
            if not 1.0 <= dur <= 7200.0:
                raise ValueError(f"duration_sec {dur} out of range 1–7200 s")
        async with _lock:
            ev = eng.inject(payload["failure_type"], payload["target_id"], dur,
                            extra={k: payload[k] for k in ("x", "z", "radius")
                                   if k in payload})
    except (KeyError, ValueError, TypeError) as ex:
        raise HTTPException(422, str(ex))
    return {"injected": True, "event": ev}


@app.post("/api/safety/reset")
async def safety_reset(payload: dict) -> dict:
    """§46：安全事件復歸（條件解除後由操作員 Reset 才恢復生產）。"""
    eng = _run("LIVE-001")
    try:
        async with _lock:
            r = eng.safety_reset(payload["cell_id"])
    except (KeyError, ValueError) as ex:
        raise HTTPException(422, str(ex))
    return r


@app.get("/api/parts")
async def parts_active(limit: int = 60) -> list[dict]:
    """§46：活動中（未完工）工件清單。"""
    eng = _run("LIVE-001")
    async with _lock:
        return eng.parts_active(limit)


@app.get("/api/parts/{part_id}")
async def part_trace(part_id: str) -> dict:
    """§46 Part Trace：單一工件追溯（路徑／位置／品質／年齡）。"""
    eng = _run("LIVE-001")
    try:
        async with _lock:
            return eng.part_trace(part_id)
    except KeyError:
        raise HTTPException(404, f"part {part_id} not found")


@app.post("/api/alerts/{alert_id}/acknowledge")
async def ack_alert(alert_id: str) -> dict:
    eng = _run("LIVE-001")
    async with _lock:
        for a in eng.alerts:
            if a["alert_id"] == alert_id:
                a["acknowledged"] = True
                eng.audit.record(sim_time=eng.clock.sim_time_iso, actor="operator",
                                 source=a["source_id"], action="ALERT_ACKNOWLEDGED",
                                 previous_state=None, new_state=None,
                                 reason=a["title"], event_seq=a["event_seq"])
                return a
    raise HTTPException(404, f"alert {alert_id} not found")


@app.get("/api/export/kpis.csv")
async def export_kpis() -> "PlainTextResponse":
    """KPI + per-minute 歷史，header 帶 run/provenance（ADR-009）。"""
    eng = _run("LIVE-001")
    async with _lock:
        k = eng.kpis()
        prov = eng.provenance
        rows = [f"# run_id={prov['run_id']} seed={prov['seed']} "
                f"parameter_hash={prov['parameter_hash']} engine={prov['engine_version']}",
                "# section=kpis"]
        rows += [f"{key},{val}" for key, val in k.items() if not isinstance(val, dict)]
        rows += [f"oee_{key},{val}" for key, val in k["oee"].items()]
        rows.append("# section=history_minutes")
        rows.append("sim_minute,good_units,defect_units,throughput_uph,oee,defect_rate,energy_kw,wip")
        for h in eng.history:
            rows.append(",".join(str(h[c]) for c in
                                 ("sim_minute", "good_units", "defect_units", "throughput_uph",
                                  "oee", "defect_rate", "energy_kw", "wip")))
    return PlainTextResponse("\n".join(rows) + "\n", media_type="text/csv")


# ---------------------------------------------------------------- 維護／Copilot／What-if（§17、§22、§23）

SCENARIOS: list[dict] = []
SCENARIO_KEEP = int(os.environ.get("TWIN_SCENARIO_KEEP", "20"))   # §53：What-if 歷史保留筆數（Reset 清空）
WHATIF = {"busy": False}


def _remember_scenario(r: dict) -> None:
    SCENARIOS.append(r)
    del SCENARIOS[:-SCENARIO_KEEP]


# 同時只跑一個 what-if（公開服務 CPU 邊界）
def _whatif_acquire() -> None:
    if WHATIF["busy"]:
        raise HTTPException(409, "a what-if is already running — retry when it finishes")
    WHATIF["busy"] = True
LATEST_EXPLANATION: dict = {}


@app.post("/api/scenarios")
async def create_scenario(payload: dict) -> dict:
    """{"failure_type","target_id","duration_sec"?,"horizon_min"?} — 同步跑
    BASELINE + SCENARIO（隔離引擎，Live 不受影響），回傳 12 項 KPI delta 與解釋。"""
    eng = _run("LIVE-001")
    try:                                       # 邊界先驗（run_scenario 內亦強制）
        validate_whatif(payload.get("duration_sec", 300), payload.get("horizon_min", 30))
        if "failure_type" not in payload or "target_id" not in payload:
            raise ValueError("failure_type and target_id are required")
    except (ValueError, TypeError, AttributeError) as ex:
        raise HTTPException(422, str(ex))
    _whatif_acquire()
    try:
        async with _lock:                      # lock 內只複製狀態（review P1-3）
            state = eng.dump_state()
        r = await asyncio.to_thread(           # CPU-heavy 模擬移出 event loop
            run_scenario, None, state=state, params=eng.params,
            failure_type=payload["failure_type"], target_id=payload["target_id"],
            duration_sec=float(payload.get("duration_sec", 300)),
            horizon_min=int(payload.get("horizon_min", 30)))
    except (KeyError, ValueError) as ex:
        raise HTTPException(422, str(ex))
    finally:
        WHATIF["busy"] = False
    r["explanation"] = explain_scenario(r)
    _remember_scenario(r)
    LATEST_EXPLANATION.clear()
    LATEST_EXPLANATION.update(r["explanation"])
    eng.audit.record(sim_time=eng.clock.sim_time_iso, actor="operator",
                     source=payload["target_id"], action="SCENARIO_RUN",
                     previous_state=None, new_state=None,
                     reason=f"{r['scenario_id']} {payload['failure_type']} "
                            f"horizon {r['horizon_min']}min",
                     event_seq=r["branch_from"]["seq"])
    return r


@app.get("/api/scenarios")
async def list_scenarios() -> list[dict]:
    return [{k: r[k] for k in ("scenario_id", "injection", "horizon_min",
                               "branch_from", "deltas")} for r in SCENARIOS]


@app.get("/api/scenarios/{scenario_id}/results")
async def scenario_results(scenario_id: str) -> dict:
    for r in SCENARIOS:
        if r["scenario_id"] == scenario_id:
            return r
    raise HTTPException(404, f"scenario {scenario_id} not found")


@app.post("/api/scenarios/{scenario_id}/apply")
async def scenario_apply(scenario_id: str) -> dict:
    """§50（WareTwin 借鏡）Apply scenario to LIVE：把該 what-if 的注入原樣打到 Live
    引擎（同一個 inject 路徑、同樣的驗證與 Audit）。"""
    r = next((x for x in SCENARIOS if x["scenario_id"] == scenario_id), None)
    if r is None:
        raise HTTPException(404, f"scenario {scenario_id} not found")
    eng = _run("LIVE-001")
    if r["branch_from"]["run_id"] != eng.run_id:        # 語意邊界——只能套回同一個 run
        raise HTTPException(409, f"{scenario_id} branched from {r['branch_from']['run_id']}; "
                                 f"live run is now {eng.run_id} — rerun the what-if first")
    inj = r["injection"]
    try:
        async with _lock:
            ev = eng.inject(inj["failure_type"], inj["target_id"], inj.get("duration_sec"))
    except (KeyError, ValueError) as ex:
        raise HTTPException(422, str(ex))
    eng.audit.record(sim_time=eng.clock.sim_time_iso, actor="operator",
                     source=inj["target_id"], action="SCENARIO_APPLIED",
                     previous_state=None, new_state=None,
                     reason=f"{scenario_id} applied to live run {eng.run_id}",
                     event_seq=ev["seq"])
    return {"applied": True, "scenario_id": scenario_id, "event": ev}


@app.post("/api/copilot/query")
async def copilot_query(payload: dict | None = None) -> dict:
    """Copilot：意圖路由 → 規則式回答（事實來源）→ Ollama 自然語言層
    （不可用時退回確定性模板，nl_source 標示來源）。"""
    question = (payload or {}).get("question", "").strip()
    eng = _run("LIVE-001")
    if not question:
        async with _lock:
            x = explain_live(eng)
        LATEST_EXPLANATION.clear()
        LATEST_EXPLANATION.update(x)
        return {"intent": "status", "explanation": x,
                "nl_text": x["summary"], "nl_source": "template"}
    async with _lock:
        r = await ask(eng, question)
    if r.get("needs_scenario"):
        # what_if：跑隔離 scenario（Live 不受影響），解釋沿用 §23 流程
        pr = r["params"]
        _whatif_acquire()                      # 與 /api/scenarios 共用單飛邊界
        try:
            async with _lock:                  # lock 內只複製狀態（review P1-3）
                state = eng.dump_state()
            sc = await asyncio.to_thread(
                run_scenario, None, state=state, params=eng.params,
                failure_type=pr["failure_type"], target_id=pr["target_id"],
                duration_sec=pr["duration_sec"], horizon_min=30)
        except ValueError as ex:
            raise HTTPException(422, str(ex))
        finally:
            WHATIF["busy"] = False
        sc["explanation"] = explain_scenario(sc)
        _remember_scenario(sc)
        text, source = await render_nl(sc["explanation"], question)
        r = {"intent": "what_if", "needs_scenario": False, "scenario_id": sc["scenario_id"],
             "deltas": sc["deltas"], "explanation": sc["explanation"],
             "nl_text": text, "nl_source": source}
    LATEST_EXPLANATION.clear()
    LATEST_EXPLANATION.update(r["explanation"])
    return r


@app.get("/api/copilot/suggestions")
async def copilot_suggestions() -> list[str]:
    return SUGGESTED_QUESTIONS


@app.get("/api/explanation/latest")
async def latest_explanation() -> dict:
    if not LATEST_EXPLANATION:
        eng = _run("LIVE-001")
        async with _lock:
            LATEST_EXPLANATION.update(explain_live(eng))
    return LATEST_EXPLANATION


@app.get("/api/maintenance")
async def maintenance() -> list[dict]:
    eng = _run("LIVE-001")
    async with _lock:
        return assess(eng)


@app.get("/api/flow/history")
async def flow_history() -> list[dict]:
    """§40.3 每分鐘 flow 快照（cell uph／util／buffers／racks／blocked·starved／AMR）。"""
    eng = _run("LIVE-001")
    async with _lock:
        return eng.flow_history


@app.get("/api/flow/insight")
async def flow_insight() -> dict:
    """§40.3 量化瓶頸成因（權威=引擎）。"""
    eng = _run("LIVE-001")
    async with _lock:
        return eng.flow_insight()


@app.get("/api/energy/breakdown")
async def energy_breakdown() -> dict:
    """§41.3/41.4：per-asset 能源帳（總量恆等於各資產之和）。"""
    eng = _run("LIVE-001")
    async with _lock:
        return eng.energy_breakdown()


@app.get("/api/energy/opportunities")
async def energy_opportunities() -> list[dict]:
    """§41.6：附證據的節能建議（模擬結果，需人工核准）。"""
    eng = _run("LIVE-001")
    async with _lock:
        return eng.energy_opportunities()


@app.post("/api/energy/whatif")
async def energy_whatif(payload: dict) -> dict:
    """§41.7：{"policies": [...], "horizon_min": 30?} — 隔離引擎比較，Live 不受影響。"""
    eng = _run("LIVE-001")
    try:
        validate_whatif(None, payload.get("horizon_min", 30))
        if not isinstance(payload.get("policies"), list) or len(payload["policies"]) > 20:
            raise ValueError("policies must be a list (≤ 20)")
    except (ValueError, TypeError, AttributeError) as ex:
        raise HTTPException(422, str(ex))
    _whatif_acquire()
    try:
        async with _lock:                      # lock 內只複製狀態（review P1-3）
            state = eng.dump_state()
        return await asyncio.to_thread(
            run_energy_scenario, None, state=state, params=eng.params,
            policies=payload["policies"],
            horizon_min=int(payload.get("horizon_min", 30)))
    except (KeyError, ValueError) as ex:
        raise HTTPException(422, str(ex))
    finally:
        WHATIF["busy"] = False


@app.get("/api/amr")
async def amr_kpis() -> dict:
    """§39.6 Intralogistics KPI（單一來源=引擎）。"""
    eng = _run("LIVE-001")
    async with _lock:
        return eng.amr_kpis()


# ---------------------------------------------------------------- Vision Inspection（§16.4）

VISION = VisionInspector()
_vision_cache: dict[str, dict] = {}


def _vision_result(seed: int, rec: dict) -> dict:
    pid = rec["part_id"]
    if pid not in _vision_cache:
        r = VISION.infer(seed, pid, rec["ground_truth"])
        r["sim_time"] = rec["sim_time"]
        r["first_pass"] = rec["first_pass"]
        _vision_cache[pid] = r
        if len(_vision_cache) > 300:
            for k in list(_vision_cache)[:100]:
                _vision_cache.pop(k, None)
    return _vision_cache[pid]


@app.get("/api/inspection/recent")
async def inspection_recent(limit: int = 8) -> list[dict]:
    """最近檢測：引擎 ground truth + 視覺模型觀測（分類/信心/bbox/一致性）。"""
    eng = _run("LIVE-001")
    seed = eng.provenance["seed"]
    async with _lock:
        recs = list(eng.recent_inspections)[-limit:]
    return [_vision_result(seed, r) for r in reversed(recs)]


@app.get("/api/inspection/{part_id}/image.png")
async def inspection_image(part_id: str) -> "Response":
    from fastapi.responses import Response
    eng = _run("LIVE-001")
    async with _lock:
        rec = next((r for r in eng.recent_inspections if r["part_id"] == part_id), None)
    if rec is None:
        raise HTTPException(404, f"{part_id} not in recent inspections")
    png = to_png(render_part_image(eng.provenance["seed"], part_id, rec["ground_truth"]))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/vision/metrics")
async def vision_metrics() -> dict:
    """線上一致性（模型觀測 vs 引擎 ground truth）+ 訓練時 held-out 指標。"""
    eng = _run("LIVE-001")
    seed = eng.provenance["seed"]
    async with _lock:
        recs = list(eng.recent_inspections)
    results = [_vision_result(seed, r) for r in recs]
    n = len(results)
    agree = sum(1 for r in results if r["agreement"])
    fr = sum(1 for r in results if r["ground_truth"] == "ok" and r["verdict"] == "FAIL")
    fa = sum(1 for r in results if r["ground_truth"] != "ok" and r["verdict"] == "PASS")
    by_type: dict[str, int] = {}
    for r in results:
        by_type[r["ground_truth"]] = by_type.get(r["ground_truth"], 0) + 1
    return {
        "window": n, "online_agreement": round(agree / n, 4) if n else None,
        "false_rejects": fr, "false_accepts": fa, "ground_truth_breakdown": by_type,
        "model_source": VISION.source, "model_meta": VISION.meta,
    }


# ---------------------------------------------------------------- WebSocket（§14.2）

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """連上先送完整 snapshot（seq = 已包含到的最後一筆 Event），之後串流 event。
    §53：accept **之前**檢查 Origin（與 REST 同規則）與連線數上限
    （總量／每 IP）；上行訊息超過上限即關閉；慢連線由 _ws_send 的逾時丟棄。"""
    h = {k.decode().lower(): v.decode() for k, v in ws.scope.get("headers", [])}
    if not origin_allowed(h.get("origin"), request_host(h), h.get("sec-fetch-site")):
        await ws.close(code=1008, reason="origin not allowed")
        return
    peer = ws.scope.get("client")
    key = client_key(h, peer[0] if peer else None)
    why = ws_registry.try_add(key)
    if why:
        await ws.close(code=1013, reason=why)            # 1013 = try again later
        return
    _WS_KEY[ws] = key                # §54：名額已計入，之後任何路徑（含 accept 例外）都由 _drop_client 釋放
    try:
        await ws.accept()            # accept 也在 try 內，失敗不洩漏名額
        eng = RUNS["LIVE-001"]
        async with _lock:
            first = json.dumps(_snapshot(eng))
        if not await _register_client(ws, first):   # §55：首份 snapshot 也有逾時，不得卡住 _send_lock
            await _safe_close(ws, 1011, "slow consumer")
            return
        while True:
            msg = await ws.receive_text()      # client 目前不需要上行訊息；超大訊息 → 關閉
            if len(msg.encode("utf-8", "ignore")) > WS_MAX_MSG_BYTES:
                await ws.close(code=1009, reason="message too big")
                break
    except WebSocketDisconnect:
        pass
    finally:
        _drop_client(ws, close=False)    # 已斷線／已由本函式關閉：只做名單與名額清理


async def _ws_send(ws: WebSocket, payload: str) -> bool:
    """§53：單一 client 的 send 有逾時；慢連線不得拖住其他訪客（回傳 False = 應丟棄）。"""
    try:
        if WS_SEND_TIMEOUT_S <= 0:            # 測試（Starlette TestClient 的記憶體 WebSocket 不容許
            await ws.send_text(payload)      # 在 send 外包 cancel scope：訊息會遺失）→ 關閉逾時
            return True
        async with asyncio.timeout(WS_SEND_TIMEOUT_S):
            await ws.send_text(payload)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- 靜態前端
_dist = ROOT / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
