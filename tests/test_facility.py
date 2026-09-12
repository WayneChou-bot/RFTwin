"""§45.8 廠務設備狀態與壓縮機故障；§45.12 維修情境事件與修復進度。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.models import SnapshotMessage  # noqa: E402
from domain_factory.serialize import snapshot_message  # noqa: E402


def _events(eng, n=400):
    return [e["event_type"] for e in eng.bus.recent(n)]


def test_facility_block_is_derived_not_fake():
    e = FactoryEngine(seed=42)
    e.run_ticks(3000)
    snap = snapshot_message(e)
    SnapshotMessage.model_validate(snap)
    f = snap["state"]["facility"]
    assert f["compressor"]["kw"] == round(e.assets["COMPRESSOR"]["kw"], 2)
    assert f["hvac"]["kw"] == round(e.assets["HVAC"]["kw"], 2)
    assert f["charger"]["kw"] == round(e.assets["CHARGER"]["kw"], 2)
    # 壓力與排煙隨焊接活動（同一權威計數）
    n = f["compressor"]["active_welders"]
    assert f["fume_extraction"]["active_hoods"] == n
    assert f["compressor"]["pressure_bar"] == round(7.0 - 0.35 * n, 2)


def test_compressor_fault_stops_welding_and_recovers():
    """壓縮機跳脫 → 焊接四站 utility_air 故障、壓縮機 0 kW、產出受影響；修復後全部恢復。"""
    e = FactoryEngine(seed=42)
    e.run_ticks(18000)
    ref = FactoryEngine(seed=42)
    ref.run_ticks(18000)
    e.inject("compressor_fault", "COMPRESSOR", duration_sec=600)
    e.run_ticks(300)
    snap = snapshot_message(e)
    w = snap["state"]["cells"][0]["stations"]
    assert all(s["state"] == "FAULT" and s["fault_kind"] == "utility_air" for s in w)
    assert snap["state"]["facility"]["compressor"]["state"] == "FAULT"
    assert e.assets["COMPRESSOR"]["kw"] == 0.0
    e.run_ticks(12000)
    ref.run_ticks(12300)
    # 焊接非瓶頸：短暫停機由 buffer 吸收（誠實物理）；600 s 才會穿透到產出
    assert e.good < ref.good, "焊接停 600 s 應少於名目產出"
    snap = snapshot_message(e)
    assert all(s["fault_kind"] is None for s in snap["state"]["cells"][0]["stations"])
    assert snap["state"]["facility"]["compressor"]["state"] != "FAULT"
    ev = _events(e, 800)
    assert ev.index("COMPRESSOR_FAULT") < ev.index("COMPRESSOR_REPAIRED")
    assert all(a["resolved"] for a in e.alerts if a["source_id"] == "COMPRESSOR")


def test_maintenance_scenario_events_and_progress():
    """tool_failure：DISPATCHED → ENTRY(15%) → EXIT(85%) → REPAIRED；fault_progress 單調。"""
    e = FactoryEngine(seed=42)
    e.run_ticks(6000)
    e.inject("tool_failure", "R-06", duration_sec=180)
    prog = []
    for _ in range(18):
        e.run_ticks(100)
        st = [s for c in snapshot_message(e)["state"]["cells"]
              for s in c["stations"] if s["station_id"] == "A-02"][0]
        if st["fault_kind"] == "tool_failure":
            prog.append(st["fault_progress"])
    assert prog == sorted(prog) and prog[0] < 0.1 and prog[-1] > 0.9
    e.run_ticks(200)
    evs = [x for x in e.bus.recent(800) if x["source_id"] == "A-02"]
    types = [x["event_type"] for x in evs]
    order = [types.index(t) for t in ("MAINTENANCE_DISPATCHED", "MAINTENANCE_ENTRY",
                                      "MAINTENANCE_EXIT", "REPAIRED")]
    assert order == sorted(order), types


def test_compressor_fault_is_deterministic_and_restorable():
    a, b = FactoryEngine(seed=42), FactoryEngine(seed=42)
    for x in (a, b):
        x.run_ticks(9000)
        x.inject("compressor_fault", "COMPRESSOR")
        x.run_ticks(1500)
    assert a.state_hash() == b.state_hash()
    c = FactoryEngine(seed=42)
    c.load_state(json.loads(json.dumps(a.dump_state())))
    a.run_ticks(600)
    c.run_ticks(600)
    assert a.state_hash() == c.state_hash()


def test_safety_requires_reset_and_blocks_cycles():
    """§46 驗收：安全事件後不得完成 Cycle；條件解除仍鎖存；Reset 後才恢復。"""
    e = FactoryEngine(seed=42)
    e.run_ticks(9000)
    comp0 = sum(s["completions"] for s in e.cells["assembly"]["stations"])
    e.inject("light_curtain", "CELL-ASSEMBLY", duration_sec=15)
    e.run_ticks(3000)                                # 條件早已解除（15 s << 300 s）
    # 全站安全停止（若有站原本 tool_failure 則 DEGRADED 亦為停止狀態）
    assert e.cell_states["assembly"] in ("FAULT", "DEGRADED")
    assert all(s2["fault_kind"] is not None for s2 in e.cells["assembly"]["stations"])
    assert sum(s["completions"] for s in e.cells["assembly"]["stations"]) == comp0
    snap = snapshot_message(e)
    cellA = next(c for c in snap["state"]["cells"] if c["cell_id"] == "CELL-ASSEMBLY")
    assert cellA["safety_awaiting_reset"] is True
    types = [x["event_type"] for x in e.bus.recent(400)]
    assert "LIGHT_CURTAIN_INTERRUPTED" in types and "SAFETY_AWAITING_RESET" in types
    r = e.safety_reset("CELL-ASSEMBLY")
    assert r["reset_stations"] == 4
    e.run_ticks(1200)
    assert sum(s["completions"] for s in e.cells["assembly"]["stations"]) > comp0
    assert "SAFETY_RESET" in [x["event_type"] for x in e.bus.recent(200)]
    e.check_conservation()


def test_emergency_stop_latches_immediately():
    e = FactoryEngine(seed=42)
    e.run_ticks(6000)
    e.inject("emergency_stop", "CELL-MACHINE_TENDING")
    e.run_ticks(50)
    assert e.cell_states["machine_tending"] == "FAULT"
    r = e.safety_reset("CELL-MACHINE_TENDING")
    assert r["reset_stations"] == 2 and r["condition_active"] == 0
    e.run_ticks(600)
    assert e.cell_states["machine_tending"] != "FAULT"


def test_reset_refused_while_condition_active():
    e = FactoryEngine(seed=42)
    e.run_ticks(6000)
    e.inject("worker_in_zone", "CELL-WELDING", duration_sec=120)
    e.run_ticks(100)                                  # 人員仍在區內
    r = e.safety_reset("CELL-WELDING")
    assert r["reset_stations"] == 0 and r["condition_active"] == 4
    assert e.cell_states["welding"] == "FAULT"


def test_amr_obstacle_pauses_then_resumes():
    e = FactoryEngine(seed=42)
    e.run_ticks(9000)
    busy = next((a for a in e.amrs if a["task"] is not None), None)
    if busy is None:                                   # 找到有任務的時刻
        for _ in range(60):
            e.run_ticks(200)
            busy = next((a for a in e.amrs if a["task"] is not None), None)
            if busy:
                break
    assert busy is not None
    ph0, rem0 = busy["task_state"], busy["phase_remaining"]
    e.inject("amr_obstacle", busy["amr_id"], duration_sec=30)
    e.run_ticks(200)                                   # 20 s < 30 s：不前進
    assert busy["task_state"] == ph0 and busy["phase_remaining"] == rem0
    assert busy["status"] == "WAITING"
    e.run_ticks(400)                                   # 障礙排除 → 續行
    types = [x["event_type"] for x in e.bus.recent(300)]
    assert "AMR_OBSTACLE" in types and "OBSTACLE_CLEARED" in types
    assert busy["phase_remaining"] < rem0 or busy["task_state"] != ph0


def test_part_trace_honest_fields():
    e = FactoryEngine(seed=42)
    e.run_ticks(6000)
    pid = next(p for p, d in e.parts.items() if d["lifecycle"] == "PROCESSING")
    t = e.part_trace(pid)
    assert t["part_id"] == pid and t["location"]["type"] == "STATION"
    ops = [r["operation"] for r in t["route"]]
    assert ops == ["WELDING", "ASSEMBLY", "MACHINING", "INSPECTION"]
    cur = [r["operation"] for r in t["route"] if r["status"] == "CURRENT"]
    assert cur and cur[0] == t["operation"]
    assert t["age_sec"] > 0 and t["carrier"] is None
    acts = e.parts_active(20)
    assert acts and all("part_id" in a for a in acts)
