"""§41 Energy：per-asset 能源帳守恆、baseline、opportunities 證據、政策 what-if。"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.whatif import run_energy_scenario  # noqa: E402


@pytest.fixture(scope="module")
def eng():
    e = FactoryEngine()
    e.run_ticks(36000)          # 1 小時
    return e


def test_total_equals_sum_of_assets(eng):
    """驗收 #12：Factory Energy == Σ Asset Energy（恆等式由建構保證）。"""
    total = eng.energy_kwh
    parts = sum(a["kwh"] for a in eng.assets.values())
    assert abs(total - parts) < 1e-6


def test_process_equipment_dominates(eng):
    """§41.3：CNC + Welding Controller 應為主要耗能來源（可信度要求）。"""
    bd = eng.energy_breakdown()
    g = bd["by_group"]
    process_kwh = g["cnc"]["kwh"] + g["welding_controller"]["kwh"]
    assert process_kwh > g["robot"]["kwh"]


def test_baseline_close_to_nominal(eng):
    """Baseline（參數模型期望）應接近名目運轉的分鐘平均（±15%）。"""
    base = eng.baseline_kw()
    avg = sum(h["energy_kw"] for h in eng.history[-30:]) / 30
    assert abs(avg - base) / base < 0.15, (avg, base)


def test_kpis_have_energy_fields(eng):
    k = eng.kpis()
    for f in ("idle_waste_kwh", "baseline_kw", "baseline_delta_pct",
              "demand_limit_kw", "units_per_kwh"):
        assert f in k
    assert k["idle_waste_kwh"] > 0


def test_opportunities_carry_evidence(eng):
    opps = eng.energy_opportunities()
    assert opps, "nominal run should surface at least one opportunity"
    for o in opps:
        assert o["evidence"] and o["affected_assets"]
        assert o["estimated_saving_kwh_shift"] >= 0
        assert "throughput_impact" in o and "confidence" in o
        assert o["requires_approval"] is True


def test_energy_whatif_saves_without_throughput_loss(eng):
    """§41.7：政策分支省能且 Δgood == 0（政策只作用於功率模型）。"""
    r = run_energy_scenario(eng, policies=["robot_auto_standby",
                                           "conveyor_stop_when_starved",
                                           "cnc_standby"], horizon_min=10)
    assert r["deltas"]["energy_kwh"] <= 0
    assert r["deltas"]["good_units"] == 0
    assert r["deltas"]["oee"] == 0
    assert r["baseline"]["energy_kwh"] > 0


def test_whatif_bigger_saving_under_disturbance():
    """擾動（雙 AMR 故障 → STARVED idle）下政策節省顯著放大。"""
    e = FactoryEngine()
    e.run_ticks(18000)
    nominal = run_energy_scenario(e, policies=["robot_auto_standby"], horizon_min=10)
    e.inject("amr_fault", "AMR-01", 1200)
    e.inject("amr_fault", "AMR-02", 1200)
    e.run_ticks(3000)
    disturbed = run_energy_scenario(e, policies=["robot_auto_standby"], horizon_min=10)
    assert disturbed["deltas"]["energy_pct"] < nominal["deltas"]["energy_pct"]
    assert disturbed["deltas"]["good_units"] == 0


def test_determinism_with_energy_model():
    a, b = FactoryEngine(), FactoryEngine()
    a.run_ticks(15000)
    b.run_ticks(15000)
    assert a.state_hash() == b.state_hash()
    assert a.energy_breakdown() == b.energy_breakdown()
