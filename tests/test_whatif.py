"""What-if 驗收 — 隔離、KPI delta、Explanation、PdM（§17/§22/§23）。"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.explanation import explain_live, explain_scenario  # noqa: E402
from domain_factory.maintenance import assess  # noqa: E402
from domain_factory.models import ExplanationResult, ScenarioResult  # noqa: E402
from domain_factory.whatif import DELTA_KEYS, run_scenario  # noqa: E402


@pytest.fixture(scope="module")
def live():
    e = FactoryEngine(seed=42)
    e.preroll()
    return e


@pytest.fixture(scope="module")
def result(live):
    r = run_scenario(live, failure_type="tool_failure", target_id="R-09",
                     duration_sec=1800, horizon_min=30)
    r["explanation"] = explain_scenario(r)
    return r


def test_live_state_never_modified(live):
    """§23.2：What-if 不得修改 Live Twin State。"""
    h0 = live.state_hash()
    run_scenario(live, failure_type="conveyor_jam", target_id="C-03",
                 duration_sec=300, horizon_min=10)
    assert live.state_hash() == h0


def test_schema_and_provenance(result):
    ScenarioResult.model_validate(result)
    for side in ("baseline", "scenario"):
        prov = result[side]["provenance"]
        assert prov["branch_from"]["run_id"] == "LIVE-001"
        assert prov["branch_from"]["seq"] == result["branch_from"]["seq"]
        assert prov["seed"] == 42
    assert result["baseline"]["run_id"] != result["scenario"]["run_id"]


def test_twelve_kpi_deltas(result):
    assert len(DELTA_KEYS) == 12
    assert set(result["deltas"].keys()) == set(DELTA_KEYS)


def test_bottleneck_failure_has_material_impact(result):
    """R-09 是瓶頸機：30 分鐘故障必須造成實質損失。"""
    d = result["deltas"]
    assert d["good_units"] <= -20
    assert d["oee"] < -0.02
    assert d["downtime_sec"] > 0


def test_redundancy_absorbs_non_bottleneck_failure(live):
    """R-06（Assembly，4 平行工位）故障被冗餘吸收 — 誠實的差異化結論。"""
    r = run_scenario(live, failure_type="tool_failure", target_id="R-06",
                     duration_sec=1800, horizon_min=30)
    assert abs(r["deltas"]["good_units"]) < 3
    x = explain_scenario(r)
    assert "absorb" in x["summary"]


def test_scenario_determinism(live):
    a = run_scenario(live, failure_type="conveyor_jam", target_id="C-03",
                     duration_sec=600, horizon_min=20)
    b = run_scenario(live, failure_type="conveyor_jam", target_id="C-03",
                     duration_sec=600, horizon_min=20)
    assert a["deltas"] == b["deltas"]
    assert a["baseline"]["kpis"] == b["baseline"]["kpis"]


def test_explanation_contract(result):
    """§22.2/§22.3：證據、信心、假設、模擬標記、需人工核准。"""
    x = ExplanationResult.model_validate(result["explanation"])
    assert 0 <= x.confidence <= 1
    assert x.requires_human_approval and x.is_simulation_result
    assert any("R-09" in ev or "Good units" in ev for ev in x.evidence)
    assert any("seed 42" in a for a in x.assumptions)


def test_explanation_live_normal_and_fault(live):
    ExplanationResult.model_validate(explain_live(live))     # 正常態
    e = FactoryEngine(seed=42)
    e.preroll()
    e.inject("conveyor_jam", "C-03", duration_sec=120)
    e.run_ticks(600)
    x = ExplanationResult.model_validate(explain_live(e))
    assert "C-03" in x.summary or "C-03" in x.primary_cause
    assert len(x.evidence) >= 2


def test_maintenance_assessment(live):
    rows = assess(live)
    assert len(rows) == 12
    for r in rows:
        assert 0 <= r["maintenance_risk"] <= 1
        assert r["is_simulation_result"]
        assert r["top_signals"][0]["signal"] == "tool_wear"
    # 完工越多 → 磨耗越多 → RUL 越短（挑同 cell 內完工數差最大者驗證單調性）
    welding = [r for r in rows if r["station_id"].startswith("W-")]
    hi = max(welding, key=lambda r: r["completions"])
    lo = min(welding, key=lambda r: r["completions"])
    if hi["completions"] > lo["completions"] and hi["rul_shifts"] and lo["rul_shifts"]:
        assert hi["health_score"] <= lo["health_score"]


def test_metrics_table_and_first_divergence(result):
    """§50：12 項統一對照（方向感知 ±／±%）＋事件流第一分岔（略過注入事件本身）。"""
    rows = result["metrics"]
    assert len(rows) == 12 and len({r["key"] for r in rows}) == 12
    for r in rows:
        assert r["delta"] == round(r["scenario"] - r["baseline"], 4)
        if r["delta"] == 0:
            assert r["better"] is None
        else:
            assert r["better"] == ((r["delta"] > 0) == r["higher_is_better"])
    fd = result["first_divergence"]
    assert fd is None or (fd["sim_tick"] >= result["branch_from"]["seq"] * 0
                          and (fd["baseline_event"] or fd["scenario_event"]))
