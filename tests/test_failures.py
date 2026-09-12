"""驗收測試 — Demo B / Demo C（§34.1）與注入機制。

時序斷言綁定 SNAP-DEMO-B：seed 42、pre-roll 完成後之自然穩態（機驗證：
machining_to_inspection ≈ 0–1、上游 buffer 滿載）。事件順序斷言限定於
Machine Tending 本地鏈；Inspection STARVED 只斷言時限（見 D-09 修正說明）。
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402


def collect(eng, kinds, since_tick=0):
    """撈出 since_tick 之後每個 (type, source) 的首次事件。"""
    out = {}
    for ev in eng.bus.dump_state()["buffer"]:
        if ev["sim_tick"] < since_tick:
            continue
        key = (ev["event_type"], ev["source_id"])
        if ev["event_type"] in kinds and key not in out:
            out[key] = ev
    return out


@pytest.fixture(scope="module")
def demo_b():
    e = FactoryEngine(seed=42)
    e.preroll()
    jam_tick = e.clock.tick
    thr0 = e.kpis()["throughput_uph"]
    e.inject("conveyor_jam", "C-03", duration_sec=240)
    e.run_ticks(6000, conservation_every=1000)      # jam 240 s + 恢復期，共 10 分鐘
    return e, jam_tick, thr0


def _t(ev, jam_tick):
    return (ev["sim_tick"] - jam_tick) / 10.0


def test_demo_b_natural_initial_conditions(demo_b):
    """SNAP-DEMO-B 前提可重現：穩態下 machining_to_inspection 近乎空、上游滿載。"""
    e = FactoryEngine(seed=42)
    e.preroll()
    assert len(e.inter["machining_to_inspection"]) <= 2
    assert len(e.inter["welding_to_assembly"]) >= 7
    assert len(e.inter["assembly_to_machining"]) >= 7


def test_demo_b_mt_local_event_order(demo_b):
    e, jam, _ = demo_b
    m = collect(e, {"CONVEYOR_JAMMED", "OUTPUT_BUFFER_FULL", "STATION_BLOCKED",
                    "CELL_BLOCKED", "CELL_STARVED"}, since_tick=jam)
    jam_ev = m[("CONVEYOR_JAMMED", "C-03")]
    full = m[("OUTPUT_BUFFER_FULL", "machining_to_inspection")]
    mt_blocked = m[("CELL_BLOCKED", "CELL-MACHINE_TENDING")]
    mt_station = min((m[k] for k in m if k[0] == "STATION_BLOCKED"
                      and k[1].startswith("M-")), key=lambda ev: ev["seq"])
    # 事件順序（seq，非只有時間）：JAMMED → OUTPUT_BUFFER_FULL → STATION_BLOCKED(M-xx)
    # → CELL_BLOCKED(MT)。OUTPUT_BUFFER_FULL 與第一台 M 站 BLOCKED 同 tick 屬合法。
    assert jam_ev["seq"] < full["seq"] <= mt_station["seq"] < mt_blocked["seq"]
    # 時限（§34.1）：MT CELL_BLOCKED ≤ 160 s
    assert _t(mt_blocked, jam) <= 160


def test_demo_b_starved_and_line_freeze(demo_b):
    e, jam, _ = demo_b
    m = collect(e, {"CELL_STARVED", "CELL_BLOCKED"}, since_tick=jam)
    starved = m[("CELL_STARVED", "CELL-VISION_INSPECTION")]
    assert 0 < _t(starved, jam) <= 240
    # 背壓凍結整條線
    for cell in ("CELL-ASSEMBLY", "CELL-WELDING"):
        assert _t(m[("CELL_BLOCKED", cell)], jam) <= 160


def test_demo_b_kpi_impact_and_recovery(demo_b):
    e, jam, thr0 = demo_b
    k = e.kpis()
    assert k["throughput_uph"] < thr0                      # 產出必須下降
    m = collect(e, {"CELL_RECOVERED", "CONVEYOR_REPAIRED"}, since_tick=jam)
    assert _t(m[("CONVEYOR_REPAIRED", "C-03")], jam) == pytest.approx(240, abs=1)
    for cell in ("CELL-MACHINE_TENDING", "CELL-ASSEMBLY", "CELL-WELDING",
                 "CELL-VISION_INSPECTION"):
        rec = m[("CELL_RECOVERED", cell)]
        assert 240 <= _t(rec, jam) <= 300                  # 修復後 60 s 內全恢復
    e.check_conservation()
    # Alert 建立且已自動 resolve
    jam_alerts = [a for a in e.alerts if a["source_id"] == "C-03"]
    assert jam_alerts and jam_alerts[-1]["resolved"]


# ---------------------------------------------------------------- Demo C

@pytest.fixture(scope="module")
def demo_c():
    e = FactoryEngine(seed=42)
    e.preroll()
    victim = next(s for s in e.cells["assembly"]["stations"] if s["robot_id"] == "R-06")
    # 等 R-06 手上有件再注入，才能驗 HELD
    while victim["part_id"] is None:
        e.step()
    held_pid = victim["part_id"]
    comp0 = victim["completions"]
    e.inject("tool_failure", "R-06", duration_sec=180)
    return e, victim, held_pid, comp0


def test_demo_c_part_held_not_completed(demo_c):
    e, st, pid, comp0 = demo_c
    assert e.parts[pid]["lifecycle"] == "HELD"             # 不得消失、不得算完成
    e.check_conservation()
    good0 = e.good
    e.run_ticks(600)                                        # 故障中跑 60 s
    assert st["completions"] == comp0                       # 不得回報 cycle completion
    assert st["fault_kind"] == "tool_failure"
    assert e.cell_states["assembly"] == "DEGRADED"
    assert e.parts[pid]["lifecycle"] == "HELD"
    assert e.good >= good0                                  # 其他工位照常生產
    e.check_conservation()


def test_demo_c_alert_and_audit(demo_c):
    e, *_ = demo_c
    al = [a for a in e.alerts if a["source_id"] == "R-06" and a["severity"] == "CRITICAL"]
    assert al, "CRITICAL alert missing"
    inj = [a for a in e.audit.entries
           if a["action"] == "FAILURE_INJECTED" and a["source"] == "R-06"]
    assert inj and inj[0]["actor"] == "operator"


def test_demo_c_repair_sends_part_to_rework(demo_c):
    e, st, pid, _ = demo_c
    e.run_ticks(1400)                                       # 跨過 180 s 修復點
    assert st["fault_kind"] is None
    part = e.parts.get(pid)
    # 修復後 Part 進 rework（REWORK_REQUIRED）→ 重工完成後重新檢測；
    # 依時點可能已重工回線甚至完成，但絕不能消失於帳目之外
    e.check_conservation()
    if part is not None:
        assert part["lifecycle"] in ("QUEUED", "PROCESSING", "IN_TRANSIT")
    assert e.cell_states["assembly"] in ("RUNNING", "BLOCKED", "STARVED")
    rec = [a for a in e.audit.entries
           if a["source"] == pid and a["new_state"] == "REWORK_REQUIRED"]
    assert rec, "audit trail for HELD → REWORK_REQUIRED missing"


# ---------------------------------------------------------------- 其他注入行為

def test_minor_stops_reduce_availability():
    e = FactoryEngine(seed=42)
    e.preroll()
    k = e.kpis()
    assert k["downtime_sec"] > 0
    assert k["oee"]["availability"] < 1.0
    assert k["oee"]["oee"] == pytest.approx(
        k["oee"]["availability"] * k["oee"]["performance"] * k["oee"]["quality"], abs=1e-3)


def test_injection_determinism():
    """相同 seed + 相同注入時點 → 相同結果（ADR-005 延伸到注入）。"""
    def run():
        e = FactoryEngine(seed=9)
        e.run_ticks(20_000)
        e.inject("conveyor_jam", "C-03", duration_sec=60)
        e.inject("tool_failure", "R-06", duration_sec=90)
        e.run_ticks(15_000)
        return e.state_hash()
    assert run() == run()


def test_invalid_injection_rejected():
    e = FactoryEngine(seed=1)
    with pytest.raises(ValueError):
        e.inject("conveyor_jam", "C-99")
    with pytest.raises(ValueError):
        e.inject("warp_core_breach", "R-01")


# ---------------------------------------------------------------- Safety Gate（§36.9，驗收 #9）

def test_safety_gate_stops_cell_and_recovers():
    e = FactoryEngine(seed=42)
    e.preroll()
    key = "welding"
    comp0 = sum(s["completions"] for s in e.cells[key]["stations"])
    e.inject("safety_gate_open", "CELL-WELDING", duration_sec=60)
    e.run_ticks(590)                                        # 閘門開啟期間
    assert e.cell_states[key] == "FAULT"
    assert sum(s["completions"] for s in e.cells[key]["stations"]) == comp0  # 不得完成 Cycle
    held_parts = [s["part_id"] for s in e.cells[key]["stations"] if s["part_id"]]
    e.check_conservation()
    # §46：條件解除後不得自動恢復——需操作員 Reset
    e.run_ticks(1500)
    assert e.cell_states[key] == "FAULT", "安全事件不得自動復歸"
    assert sum(s["completions"] for s in e.cells[key]["stations"]) == comp0
    r = e.safety_reset("CELL-WELDING")
    assert r["reset_stations"] == 4 and r["condition_active"] == 0
    e.run_ticks(1500)                                       # Reset 後恢復
    assert e.cell_states[key] in ("RUNNING", "BLOCKED", "STARVED")
    assert sum(s["completions"] for s in e.cells[key]["stations"]) > comp0   # 續跑
    for pid in held_parts:
        assert pid not in e.parts or e.parts[pid]["lifecycle"] != "HELD"
    e.check_conservation()
    ev = [x for x in e.bus.dump_state()["buffer"] if x["event_type"] == "SAFETY_GATE_OPEN"]
    assert ev and ev[0]["source_id"] == "CELL-WELDING"


def test_safety_gate_starves_downstream():
    e = FactoryEngine(seed=42)
    e.preroll()
    e.inject("safety_gate_open", "CELL-MACHINE_TENDING", duration_sec=180)
    e.run_ticks(1800)
    e.safety_reset("CELL-MACHINE_TENDING")   # §46：Reset 語意（本測試只看下游斷料）
    m = collect(e, {"CELL_STARVED"}, since_tick=e.clock.tick - 1800)
    assert ("CELL_STARVED", "CELL-VISION_INSPECTION") in m   # 下游斷料
    e.check_conservation()
