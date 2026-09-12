"""§44 Side-Zone 引擎誠實化：per-SKU Supermarket、Staging 出貨鏈、廠務能耗。"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import RACK_SKU, FactoryEngine  # noqa: E402
from domain_factory.serialize import snapshot_message  # noqa: E402

SKUS = set(RACK_SKU.values())


@pytest.fixture(scope="module")
def run():
    """1 小時 run；沿途收集完整事件流（bus retention 之前取走）。"""
    e = FactoryEngine(run_id="SIDEZONE", seed=42)
    events, last = [], 0
    for _ in range(72):
        e.run_ticks(500)
        evs, ok = e.bus.after(last, limit=5000)
        assert ok, "event gap — retention overrun"
        if evs:
            events.extend(evs)
            last = evs[-1]["seq"]
    return e, events


def test_supermarket_per_sku(run):
    """§44.2：Supermarket 為 per-SKU 庫存；外部供應把任一 SKU 補回門檻之上。"""
    eng, events = run
    sm = eng.supermarket
    assert set(sm["per_sku"]) == SKUS
    cap = sm["capacity_per_sku"]
    for sku, qty in sm["per_sku"].items():
        assert 0 <= qty <= cap, (sku, qty)
    types = [ev["event_type"] for ev in events]
    # v8（§45.3）：外部供應改事件鏈；1h 內至少一輪完整收貨
    for c in ("DELIVERY_ARRIVED", "DOOR_OPENING", "PALLET_RECEIVED",
              "RECEIVING_INSPECTION", "MATERIAL_REGISTERED", "MOVED_TO_SUPERMARKET"):
        assert c in types, f"1h 內應觸發外部供應（缺 {c}）"
    assert "SUPPLY_DELIVERY" not in types


def test_fg_staging_chain(run):
    """§44.8：shipped 於 Staging 卸貨計入；20/板 → PALLET_READY；3 板 → 出貨。"""
    eng, events = run
    assert eng.shipped == eng.staging_units + eng.outbound_total
    assert 0 <= eng.fg_picked <= eng.good        # 在途 FG 不能為負
    assert eng.shipped <= eng.fg_picked
    types = [ev["event_type"] for ev in events]
    il = eng.params["intralogistics"]["staging"]
    assert types.count("PALLET_READY") == eng.shipped // il["pallet_size"]
    truck = il["pallet_size"] * il["pallets_per_truck"]
    assert eng.outbound_total == types.count("OUTBOUND_SHIPPED") * truck
    assert types.count("OUTBOUND_SHIPPED") >= 1, "1h 內應至少出一車"
    # v8（§45.4）：出貨事件鏈 ASSIGNED → DOCKED → SHIPPED（可有一車在途）
    n_ship = types.count("OUTBOUND_SHIPPED")
    assert n_ship <= types.count("DOCKED") <= types.count("OUTBOUND_ASSIGNED") <= n_ship + 1


def test_finished_buffer_excludes_picked(run):
    """finished_buffer 佔用 = good − fg_picked（被 AMR 取走的不再堆在線邊）。"""
    eng, _ = run
    snap = snapshot_message(eng)
    fb = snap["state"]["finished_buffer"]
    assert fb["occupancy"] == eng.good - eng.fg_picked
    st = snap["state"]["staging"]
    assert st["units"] == eng.staging_units
    assert st["outbound_total"] == eng.outbound_total
    per = {r["sku"]: r["qty"] for r in snap["state"]["supermarket"]["per_sku"]}
    assert per == eng.supermarket["per_sku"]


def test_facility_energy_assets(run):
    """§44.10：Compressed Air／HVAC 入帳；恆等式仍成立；壓縮機跟隨焊接。"""
    eng, _ = run
    e = eng.params["energy"]
    comp, hv = eng.assets["COMPRESSOR"], eng.assets["HVAC"]
    assert abs(hv["kwh"] - e["hvac_kw"] * 1.0) < 0.1          # 常載 × 1h
    assert comp["kwh"] > e["compressed_air"]["base_kw"] * 1.0  # 焊接活動加成
    n_weld_max = len(eng.cells["welding"]["stations"])
    peak = e["compressed_air"]["base_kw"] \
        + n_weld_max * e["compressed_air"]["per_active_welder_kw"]
    assert e["compressed_air"]["base_kw"] <= comp["kw"] <= peak + 1e-9
    assert abs(eng.energy_kwh - sum(a["kwh"] for a in eng.assets.values())) < 1e-6
    bd = eng.energy_breakdown()
    assert "compressed_air" in bd["by_group"] and "hvac" in bd["by_group"]
    assert "FACILITY" in bd["by_cell"]


def test_dump_load_roundtrip_v7(run):
    """v7 新狀態（per-SKU／staging／fg_picked）經 dump/load 後仍決定性。"""
    eng, _ = run
    d = json.loads(json.dumps(eng.dump_state()))
    e2 = FactoryEngine(run_id="SIDEZONE", seed=42)
    e2.load_state(d)
    assert e2.supermarket == eng.supermarket
    assert (e2.fg_picked, e2.staging_units, e2.outbound_total) == \
           (eng.fg_picked, eng.staging_units, eng.outbound_total)
    eng.run_ticks(600)
    e2.run_ticks(600)
    assert e2.state_hash() == eng.state_hash()
    assert e2.shipped == eng.shipped
