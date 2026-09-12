"""API 測試 — snapshot、after_seq 補送語意、WS 首訊息（ADR-004）。

TestClient 下 startup 會跑完整 pre-roll（約 3 秒）。
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from apps.factory_backend.main import app  # noqa: E402
from domain_factory.models import AmrPatchMessage, ControlMessage, EventMessage, SnapshotMessage  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        # 暫停背景推進，讓測試在固定狀態上斷言
        c.post("/api/simulation/pause")
        yield c


def test_runs_provenance(client):
    r = client.get("/api/runs").json()
    assert r[0]["run_id"] == "LIVE-001"
    assert r[0]["seed"] == 42
    assert r[0]["parameter_hash"].startswith("sha256:")
    assert r[0]["initial_snapshot_id"].startswith("SNAP-PREROLL-42-")


def test_snapshot_schema_and_seq(client):
    snap = client.get("/api/runs/LIVE-001/snapshot").json()
    SnapshotMessage.model_validate(snap)
    assert snap["seq"] == max(e["seq"] for e in snap["state"]["recent_events"])


def test_events_after_seq_exclusive(client):
    snap = client.get("/api/runs/LIVE-001/snapshot").json()
    last = snap["seq"]
    r = client.get(f"/api/runs/LIVE-001/events", params={"after_seq": last - 5}).json()
    assert r["complete"] is True
    assert [e["seq"] for e in r["events"]] == list(range(last - 4, last + 1))
    r2 = client.get(f"/api/runs/LIVE-001/events", params={"after_seq": last}).json()
    assert r2["events"] == []          # exclusive：沒有新事件


def test_events_out_of_window(client):
    r = client.get("/api/runs/LIVE-001/events", params={"after_seq": 0}).json()
    assert r["complete"] is False       # 超出保留窗口 → client 應重取 snapshot


def test_kpi_endpoint_consistent_with_snapshot(client):
    k = client.get("/api/kpis").json()
    snap = client.get("/api/runs/LIVE-001/snapshot").json()
    assert k["good_units"] == snap["state"]["kpis"]["good_units"]
    assert k["oee"]["oee"] == snap["state"]["kpis"]["oee"]["oee"]


def test_websocket_snapshot_then_events(client):
    with client.websocket_connect("/ws") as ws:
        first = json.loads(ws.receive_text())
        assert first["type"] == "snapshot"
        SnapshotMessage.model_validate(first)
        last = first["seq"]
        client.post("/api/simulation/start")
        # 之後串流 event（穿插 1 Hz 週期 snapshot）；任何 event 相對最近的
        # snapshot/last_seq 必須無 gap（§14.2）
        got = None
        patches = controls = 0
        for _ in range(60):
            m = json.loads(ws.receive_text())
            if m["type"] == "snapshot":
                last = m["seq"]
                continue
            if m["type"] == "amr_patch":         # §50：10 Hz 位置增量（不佔 seq）
                AmrPatchMessage.model_validate(m)
                assert m["run_id"] == first["run_id"]
                patches += 1
                continue
            if m["type"] == "control":           # §51：控制變更廣播（不佔 seq）
                ControlMessage.model_validate(m)
                assert m["control"]["paused"] is False
                controls += 1
                continue
            got = m
            break
        client.post("/api/simulation/pause")
        assert got is not None
        EventMessage.model_validate(got)
        assert got["seq"] == last + 1            # 快照之後第一筆 = seq+1（無 gap）
        assert patches >= 1
        assert controls == 1                     # start → 一筆 control 廣播


def test_control_state_in_snapshot_and_broadcast(client):
    """§51：snapshot 帶後端控制狀態；pause／speed 變更即廣播 control，所有分頁一致。"""
    client.post("/api/simulation/pause")
    snap = client.get("/api/runs/LIVE-001/snapshot").json()
    SnapshotMessage.model_validate(snap)
    assert snap["control"]["paused"] is True and "seq" in snap["control"]
    ctl = client.get("/api/simulation/control").json()
    assert ctl["paused"] is True and ctl["run_id"] == snap["run_id"]
    with client.websocket_connect("/ws") as ws:
        first = json.loads(ws.receive_text())
        assert first["control"]["paused"] is True
        client.post("/api/simulation/speed?value=5")
        m = json.loads(ws.receive_text())
        ControlMessage.model_validate(m)
        assert m["type"] == "control" and m["control"]["paused"] is True and m["control"]["speed"] == 5.0
        assert m["control"]["seq"] > first["control"]["seq"]     # §52：控制 seq 單調遞增
        assert m["run_id"] == first["run_id"]
    client.post("/api/simulation/speed?value=1")


def test_unknown_run_404(client):
    assert client.get("/api/runs/NOPE/snapshot").status_code == 404


def test_inject_ack_and_csv(client):
    r = client.post("/api/failures/inject",
                    json={"failure_type": "minor_stop", "target_id": "W-03",
                          "duration_sec": 30}).json()
    assert r["injected"] and r["event"]["event_type"] == "MINOR_STOP"
    bad = client.post("/api/failures/inject",
                      json={"failure_type": "conveyor_jam", "target_id": "C-99"})
    assert bad.status_code == 422
    jam = client.post("/api/failures/inject",
                      json={"failure_type": "conveyor_jam", "target_id": "C-03"}).json()
    alerts = client.get("/api/alerts").json()
    target = [a for a in alerts if a["source_id"] == "C-03"][-1]
    acked = client.post(f"/api/alerts/{target['alert_id']}/acknowledge").json()
    assert acked["acknowledged"] is True
    csv = client.get("/api/export/kpis.csv").text
    assert csv.startswith("# run_id=LIVE-001 seed=42 parameter_hash=sha256:")
    assert "sim_minute,good_units" in csv


def test_scenario_and_explanation_endpoints(client):
    r = client.post("/api/scenarios",
                    json={"failure_type": "conveyor_jam", "target_id": "C-03",
                          "duration_sec": 300, "horizon_min": 10}).json()
    assert set(r["deltas"]).__len__() == 12
    assert r["explanation"]["requires_human_approval"] is True
    got = client.get(f"/api/scenarios/{r['scenario_id']}/results").json()
    assert got["branch_from"] == r["branch_from"]
    latest = client.get("/api/explanation/latest").json()
    assert latest["summary"] == r["explanation"]["summary"]
    live_x = client.post("/api/copilot/query", json={}).json()
    assert live_x["intent"] == "status"
    assert "evidence" in live_x["explanation"] and live_x["explanation"]["is_simulation_result"]
    ask = client.post("/api/copilot/query",
                      json={"question": "Which station is the bottleneck?"}).json()
    assert ask["intent"] == "bottleneck" and ask["nl_source"] in ("ollama", "template")
    assert "MACHINE_TENDING" in ask["nl_text"]
    sugg = client.get("/api/copilot/suggestions").json()
    assert len(sugg) >= 5
    pdm = client.get("/api/maintenance").json()
    assert len(pdm) == 12 and 0 <= pdm[0]["maintenance_risk"] <= 1


def test_vision_endpoints(client):
    recent = client.get("/api/inspection/recent?limit=5").json()
    assert recent, "no recent inspections after preroll"
    r0 = recent[0]
    assert {"part_id", "predicted", "confidence", "verdict", "ground_truth",
            "agreement", "model_source"} <= set(r0)
    img = client.get(f"/api/inspection/{r0['part_id']}/image.png")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert client.get("/api/inspection/NOPE/image.png").status_code == 404
    m = client.get("/api/vision/metrics").json()
    assert m["window"] > 0 and m["model_source"] in ("onnx", "heuristic")
    assert m["online_agreement"] is None or m["online_agreement"] >= 0.8


def test_reset_does_not_block_event_loop(client):
    """Reset 的 pre-roll 在 worker thread；期間 /api/health 仍須即時回應。"""
    import threading
    import time

    done: dict = {}

    def _reset():
        t0 = time.perf_counter()
        done["resp"] = client.post("/api/simulation/reset")
        done["sec"] = time.perf_counter() - t0

    th = threading.Thread(target=_reset)
    th.start()
    worst = 0.0
    while th.is_alive():
        t0 = time.perf_counter()
        r = client.get("/api/health")
        worst = max(worst, time.perf_counter() - t0)
        assert r.status_code == 200
        time.sleep(0.05)
    th.join()
    assert done["resp"].status_code == 200
    assert done["resp"].json()["run_id"] != "LIVE-001"
    assert done["sec"] > 1.0, "pre-roll 應耗時（否則測試無意義）"
    assert worst < 1.0, f"health 在 reset 期間最慢 {worst:.2f}s（event loop 被阻塞）"


def test_reset_freezes_old_run_and_health_reports_it(client):
    """§49：Reset 重建期間舊 run 凍結——health 的 seq／sim_time 不得推進，
    且 health 回報 resetting=true；完成後 run_id 遞增、resetting=false。"""
    import threading
    import time

    done: dict = {}

    def _reset():
        done["resp"] = client.post("/api/simulation/reset")

    h0 = client.get("/api/health").json()
    th = threading.Thread(target=_reset)
    th.start()
    time.sleep(0.4)                          # 讓 reset 進入重建
    seen_resetting = False
    seqs = []
    while th.is_alive():
        h = client.get("/api/health").json()
        if h.get("resetting"):
            seen_resetting = True
            if h["run_id"] == h0["run_id"]:
                seqs.append(h["seq"])
        time.sleep(0.05)
    th.join()
    assert done["resp"].status_code == 200
    assert seen_resetting, "health 應在重建期間回報 resetting=true"
    assert len(set(seqs)) <= 1, f"舊 run 在重建期間仍推進：{sorted(set(seqs))[:5]}"
    h1 = client.get("/api/health").json()
    assert h1["run_id"] == done["resp"].json()["run_id"] and not h1["resetting"]


def test_scenario_apply_to_live(client):
    """§50 Apply scenario to LIVE：同一注入打到 Live（同 inject 路徑）並寫 Audit。"""
    r = client.post("/api/scenarios", json={"failure_type": "conveyor_jam", "target_id": "C-03",
                                            "duration_sec": 120, "horizon_min": 5})
    assert r.status_code == 200
    sid = r.json()["scenario_id"]
    assert len(r.json()["metrics"]) == 12
    a = client.post(f"/api/scenarios/{sid}/apply")
    assert a.status_code == 200 and a.json()["applied"]
    assert a.json()["event"]["event_type"] == "CONVEYOR_JAMMED"
    audit = client.get("/api/audit").json()
    assert any(x["action"] == "SCENARIO_APPLIED" and sid in x["reason"] for x in audit)
    assert client.post("/api/scenarios/SC-999/apply").status_code == 404


def test_whatif_semantic_bounds(client):
    """What-if 語意邊界——負值／0／超大 horizon 一律 422；能源 what-if 同樣。"""
    bad = [{"duration_sec": -5, "horizon_min": 5}, {"duration_sec": 120, "horizon_min": 0},
           {"duration_sec": 120, "horizon_min": 100000}, {"duration_sec": 1e9, "horizon_min": 5},
           {"duration_sec": "abc", "horizon_min": 5}]
    for extra in bad:
        r = client.post("/api/scenarios", json={"failure_type": "conveyor_jam", "target_id": "C-03", **extra})
        assert r.status_code == 422, (extra, r.text)
        assert "out of range" in r.text or "must be" in r.text
    assert client.post("/api/scenarios", json={"target_id": "C-03"}).status_code == 422
    r = client.post("/api/energy/whatif", json={"policies": ["idle_shutdown"], "horizon_min": 9999})
    assert r.status_code == 422
    r = client.post("/api/energy/whatif", json={"policies": "x", "horizon_min": 5})
    assert r.status_code == 422


def test_whatif_single_flight(client):
    """同時只跑一個 what-if；第二個立刻 409（不排隊、不吃 CPU）。"""
    from apps.factory_backend import main as m
    m.WHATIF["busy"] = True
    try:
        r = client.post("/api/scenarios", json={"failure_type": "conveyor_jam", "target_id": "C-03",
                                                "duration_sec": 60, "horizon_min": 5})
        assert r.status_code == 409
        r = client.post("/api/copilot/query", json={"question": "what if R-09 fails for 10 min"})
        assert r.status_code == 409
    finally:
        m.WHATIF["busy"] = False
    r = client.post("/api/scenarios", json={"failure_type": "conveyor_jam", "target_id": "C-03",
                                            "duration_sec": 60, "horizon_min": 5})
    assert r.status_code == 200


def test_reset_prunes_registry_and_apply_refuses_stale_scenario(client):
    """連續 Reset 後 registry 不成長、/api/runs 不重複、舊 run 回 410、
    AMR_PREV 清理；從舊 run 分支的 scenario 不能 Apply 到新 run（409）。"""
    from apps.factory_backend import main as m
    if client.get("/api/runs/LIVE-001/snapshot").json()["run_id"] == "LIVE-001":
        client.post("/api/simulation/reset")              # 先取得一個有編號的 run（LIVE-001 是永久別名）
    sc = client.post("/api/scenarios", json={"failure_type": "conveyor_jam", "target_id": "C-03",
                                             "duration_sec": 60, "horizon_min": 5}).json()
    old_run = client.get("/api/runs/LIVE-001/snapshot").json()["run_id"]
    sizes = []
    for _ in range(3):
        r = client.post("/api/simulation/reset")
        assert r.status_code == 200
        sizes.append(len(m.RUNS))
        runs = client.get("/api/runs").json()
        ids = [p["run_id"] for p in runs]
        assert len(ids) == len(set(ids)) == 1, ids
        assert set(m.AMR_PREV) <= set(m.RUNS)
    assert sizes == [2, 2, 2], sizes                  # 實際 run_id ＋ LIVE-001 別名，不再成長
    assert client.get(f"/api/runs/{old_run}/snapshot").status_code == 410
    # §53：Reset 清空 what-if 歷史 → 舊 scenario 不存在（404）；若仍存在也會因 run 不符被 409 擋下
    a = client.post(f"/api/scenarios/{sc['scenario_id']}/apply")
    assert a.status_code in (404, 409)
    client.post("/api/simulation/pause")


def test_inject_duration_bounds(client):
    """§52：注入時長 1–7200 s，越界 422（含負值與非數字）。"""
    for d in (-5, 0, 1e9, "abc"):
        r = client.post("/api/failures/inject", json={"failure_type": "minor_stop", "target_id": "W-01",
                                                      "duration_sec": d})
        assert r.status_code == 422, (d, r.text)


def test_scenario_retention_and_reset_clears(client):
    """§53：What-if 歷史最多保留 SCENARIO_KEEP 筆，Reset 後清空。"""
    from apps.factory_backend import main as m
    m.SCENARIO_KEEP = 3
    m.SCENARIOS.clear()
    for i in range(5):
        m._remember_scenario({"scenario_id": f"SC-T{i}", "injection": {}, "horizon_min": 5,
                              "branch_from": {"run_id": "x", "seq": 0}, "deltas": {}})
    assert [r["scenario_id"] for r in client.get("/api/scenarios").json()] == ["SC-T2", "SC-T3", "SC-T4"]
    assert client.post("/api/simulation/reset").status_code == 200
    assert client.get("/api/scenarios").json() == []
    m.SCENARIO_KEEP = 20
    client.post("/api/simulation/pause")
