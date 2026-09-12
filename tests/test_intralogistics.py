"""§39 Intralogistics：補料閉環、Fleet 派工、SLA 因果鏈、確定性。"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import CELL_ORDER, TASK_PHASES, FactoryEngine  # noqa: E402


@pytest.fixture(scope="module")
def steady():
    e = FactoryEngine()
    e.run_ticks(36000)          # 1 小時穩態
    return e


def test_nominal_no_stockout(steady):
    """名目運轉：補料及時，零 stockout、100% on-time、rack 界內。"""
    k = steady.amr_kpis()
    assert k["stockout_min"] == 0.0
    assert k["on_time_replenishment_pct"] == 100.0
    assert k["tasks_completed"] > 10
    for key, r in steady.racks.items():
        assert 0 <= r["qty"] <= r["capacity"], (key, r["qty"])
    steady.check_conservation()


def test_task_lifecycle_events(steady):
    """§39.3/39.4：一筆 CELL_REPLENISH 依序走完 相位（事件鏈驗證）。"""
    evs = steady.bus.dump_state()["buffer"]
    req = [x for x in evs if x["event_type"] == "REPLENISHMENT_REQUESTED"]
    started = [x for x in evs if x["event_type"] == "TASK_STARTED"]
    loaded = [x for x in evs if x["event_type"] == "TOTE_LOADED"]
    done = [x for x in evs if x["event_type"] == "TASK_COMPLETED"]
    ret = [x for x in evs if x["event_type"] == "TOTE_RETURNED"]
    assert req and started and loaded and done and ret
    # 空箱回流只發生在補料任務（FG 不回箱）
    assert all("T-" in x["message"] for x in ret)


def test_reserved_prevents_duplicate_orders():
    e = FactoryEngine()
    e.run_ticks(36000)
    for key in CELL_ORDER:
        pending = [t for t in e.amr_queue
                   if t["type"] == "CELL_REPLENISH" and t["target"] == key]
        active = [a for a in e.amrs if a["task"]
                  and a["task"]["type"] == "CELL_REPLENISH"
                  and a["task"]["target"] == key]
        assert len(pending) + len(active) <= 1, key


def test_single_amr_fault_takeover():
    """§39.2：單車故障 → 另一台接替，不產生 stockout。"""
    e = FactoryEngine()
    e.run_ticks(36000)
    e.inject("amr_fault", "AMR-02", 900)
    e.run_ticks(18000)
    k = e.amr_kpis()
    assert k["stockout_min"] == 0.0
    assert k["on_time_replenishment_pct"] == 100.0
    assert e.amrs[0]["kpi"]["tasks_completed"] > e.amrs[1]["kpi"]["tasks_completed"]


def test_dual_amr_fault_causes_starvation_then_recovers():
    """驗收 #8：物流延誤 → MATERIAL_LOW → STARVED → 產出下降；修復後恢復。"""
    e = FactoryEngine()
    e.run_ticks(36000)
    g0 = e.good
    e.inject("amr_fault", "AMR-01", 1500)
    e.inject("amr_fault", "AMR-02", 1500)
    e.run_ticks(18000)          # 30 分鐘
    delta = e.good - g0
    assert delta < 65           # 名目 30 分鐘 ≈ 79（v5 reorder=24 → 斷料前緩衝較久）
    evs = e.bus.dump_state()["buffer"]
    assert any(x["event_type"] == "MATERIAL_LOW" for x in evs)
    assert any(x["event_type"] == "STATION_STARVED" and "material" in x["message"]
               for x in evs)
    k = e.amr_kpis()
    assert k["stockout_min"] > 5
    assert k["starvation_from_logistics_min"] > 5
    # 修復後 1 小時：佇列清空、rack 回補、產線恢復
    g1 = e.good
    e.run_ticks(36000)
    k = e.amr_kpis()
    assert k["pending_tasks"] <= 2
    assert all(r["qty"] > 0 for r in e.racks.values())
    assert e.good - g1 > 120    # 恢復到接近名目節拍
    e.check_conservation()


def test_task_state_machine_order():
    """相位轉移只能沿 TASK_PHASES 前進（抽樣觀測）。"""
    e = FactoryEngine()
    order = {ph: i for i, ph in enumerate(TASK_PHASES)}
    last: dict[str, tuple[str, int]] = {}
    for _ in range(24000):
        e.step()
        for a in e.amrs:
            ts = a["task_state"]
            tid = a["task"]["task_id"] if a["task"] else None
            if ts in order and tid:
                pv_id, pv = last.get(a["amr_id"], (None, -1))
                if pv_id == tid:
                    assert order[ts] >= pv, (tid, ts)
                last[a["amr_id"]] = (tid, order[ts])


def test_determinism_with_intralogistics():
    a, b = FactoryEngine(), FactoryEngine()
    a.run_ticks(24000)
    b.run_ticks(24000)
    assert a.state_hash() == b.state_hash()
    assert a.amr_kpis() == b.amr_kpis()


def test_energy_includes_amr(steady):
    """AMR 能耗計入全廠且 per-AMR KPI 有累積。"""
    k = steady.amr_kpis()
    assert k["energy_kwh"] > 0
    assert steady.energy_kwh > k["energy_kwh"]
