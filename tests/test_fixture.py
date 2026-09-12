"""Canonical fixture 驗收測試（§32 Conservation/Consistency/Schema）。"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from domain_factory.models import SnapshotMessage  # noqa: E402
from domain_factory.params import CONFIG_PATH, load_params, parameter_hash  # noqa: E402


@pytest.fixture(scope="module")
def snap() -> dict:
    return json.loads((ROOT / "fixtures" / "snapshot.live-001.json").read_text(encoding="utf-8"))


def test_pydantic_valid(snap):
    SnapshotMessage.model_validate(snap)


def test_conservation(snap):
    """§13.3: created = wip + good_completed + scrap；子集不重複。"""
    p = snap["state"]["parts"]
    assert p["created"] == p["wip"] + p["good_completed"] + p["scrap"]
    assert p["held"] + p["rework_wip"] <= p["wip"]


def test_wip_matches_layout(snap):
    """WIP 計數 = 各位置實際件數總和（Buffer + Station + Conveyor + Rework）。"""
    st = snap["state"]
    stations = sum(1 for c in st["cells"] for s in c["stations"] if s["current_part_id"])
    conveyors = sum(c["item_count"] for c in st["conveyors"])
    inter_buffers = sum(c["output_buffer"]["occupancy"] for c in st["cells"]
                        if c["output_buffer"]["buffer_id"] != "finished_goods")
    rework = st["rework_buffer"]["occupancy"]
    assert st["parts"]["wip"] == stations + conveyors + inter_buffers + rework


def test_oee_formula(snap):
    """§18.2: OEE = A × P × Q，各項可由原始量重算。"""
    k = snap["state"]["kpis"]
    o = k["oee"]
    assert o["availability"] == pytest.approx(k["runtime_sec"] / k["planned_time_sec"], abs=1e-3)
    params = load_params()
    mt = params["cells"]["machine_tending"]["station_cycle_sec"]
    ideal = (mt["load"] + mt["machine_processing"] + mt["unload"]) / \
        len(params["cells"]["machine_tending"]["stations"])
    assert o["performance"] == pytest.approx(ideal * k["total_output"] / k["runtime_sec"], abs=1e-3)
    assert o["quality"] == pytest.approx(k["good_units"] / k["total_output"], abs=1e-3)
    assert o["oee"] == pytest.approx(o["availability"] * o["performance"] * o["quality"], abs=1e-3)
    assert o["performance"] <= 1.0


def test_kpi_consistency(snap):
    """§32 Consistency: 相同指標各處一致。"""
    st = snap["state"]
    k = st["kpis"]
    assert k["good_units"] == st["parts"]["good_completed"]
    assert k["wip"] == st["parts"]["wip"]
    assert k["rework_units"] == st["parts"]["rework_wip"]
    assert k["total_output"] == st["parts"]["good_completed"] + st["parts"]["scrap"]
    assert st["orders"][0]["completed_quantity"] == k["good_units"]
    assert st["finished_buffer"]["occupancy"] == \
        k["good_units"] - st["parts"]["shipped"]      # AMR 已出貨的不留在 finished
    # 歷史積分 = 總量
    assert sum(p["good_units"] for p in st["history_minutes"]) == k["good_units"]
    assert sum(p["defect_units"] for p in st["history_minutes"]) == k["defect_units"]
    assert len(st["history_minutes"]) == 240
    # 產能檢查：throughput 不得超過瓶頸理論值（160 uph）
    assert k["throughput_uph"] <= 160.0


def test_quality_math(snap):
    k = snap["state"]["kpis"]
    assert k["first_pass_yield"] == pytest.approx(1 - k["defect_rate"], abs=1e-4)
    assert k["energy_kwh_per_unit"] == pytest.approx(
        k["energy_kwh_total"] / k["good_units"], abs=1e-3)


def test_seq_semantics(snap):
    """§14.2: Snapshot 的 seq = 已包含到的最後一筆 Event。"""
    assert snap["type"] == "snapshot"
    seqs = [e["seq"] for e in snap["state"]["recent_events"]]
    assert seqs == sorted(seqs)
    assert max(seqs) == snap["seq"]
    for a in snap["state"]["alerts"]:
        assert a["event_seq"] <= snap["seq"]


def test_provenance(snap):
    """ADR-009: parameter_hash 與 YAML、檔頭記錄一致。"""
    prov = snap["provenance"]
    assert prov["parameter_hash"] == parameter_hash(load_params())
    header = CONFIG_PATH.read_text(encoding="utf-8")
    recorded = [ln for ln in header.splitlines() if "sha256:" in ln][0]
    assert prov["parameter_hash"].split("sha256:")[1] in recorded
    assert prov["seed"] == 42
    assert prov["run_id"] == snap["run_id"]


def test_machine_tending_model(snap):
    """§10.6: 1 Robot ↔ 1 CNC；WAITING_MACHINE 不計 Active。"""
    robots = {r["robot_id"]: r for r in snap["state"]["robots"]}
    mt_cell = [c for c in snap["state"]["cells"] if c["cell_id"] == "CELL-MACHINE_TENDING"][0]
    machines = [s["machine_id"] for s in mt_cell["stations"]]
    assert sorted(machines) == ["CNC-01", "CNC-02"]
    waiting = [r for r in robots.values() if r["status"] == "WAITING_MACHINE"]
    for r in waiting:
        assert r["cell_id"] == "CELL-MACHINE_TENDING"
        assert r["energy_kw"] < 2.0


def test_deterministic_serialization():
    """相同 seed → 相同 wire snapshot（generated_at 牆鐘欄位除外）。"""
    from domain_factory.engine import FactoryEngine
    from domain_factory.serialize import snapshot_message

    def run():
        e = FactoryEngine(seed=7)
        e.run_ticks(6000)          # 10 模擬分鐘（完整 preroll 由 test_engine 覆蓋）
        m = snapshot_message(e)
        m.pop("generated_at")
        return json.dumps(m, sort_keys=True, default=str)

    assert run() == run()
