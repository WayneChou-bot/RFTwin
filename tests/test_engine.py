"""引擎驗收測試（§32 Determinism / Conservation / Provenance；ADR-005）。"""
import json
import sys
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402


def test_determinism_same_seed():
    """相同 seed／參數 → 相同事件序列與相同狀態雜湊。"""
    a, b = FactoryEngine(seed=42), FactoryEngine(seed=42)
    a.run_ticks(30_000)
    b.run_ticks(30_000)
    assert a.state_hash() == b.state_hash()
    assert a.bus.seq == b.bus.seq
    assert [e["event_type"] for e in a.bus.recent(50)] == \
           [e["event_type"] for e in b.bus.recent(50)]


def test_different_seed_diverges():
    a, b = FactoryEngine(seed=1), FactoryEngine(seed=2)
    a.run_ticks(60_000)     # 需要跑到有檢測判定發生
    b.run_ticks(60_000)
    assert a.state_hash() != b.state_hash()


def test_snapshot_restore_continuation():
    """從 snapshot 恢復後繼續跑 = 不中斷地跑（ADR-005 #4）。"""
    a = FactoryEngine(seed=42)
    a.run_ticks(50_000)
    saved = a.dump_state()
    a.run_ticks(20_000)

    b = FactoryEngine(seed=42)
    b.load_state(json.loads(json.dumps(saved)))     # 經 JSON round-trip
    b.run_ticks(20_000)
    assert a.state_hash() == b.state_hash()


def test_conservation_over_time():
    e = FactoryEngine(seed=42)
    e.run_ticks(80_000, conservation_every=2_000)
    e.check_conservation()
    p = e.parts
    # Part 位置一致性：registry 中每件都要有位置
    for pt in p.values():
        assert pt["location_type"] in ("STATION", "BUFFER", "CONVEYOR", "REWORK_AREA")


def test_preroll_budget_and_history():
    """§31: 144,000 ticks headless 10 秒內；240 個 per-minute 點。"""
    e = FactoryEngine(seed=42)
    t0 = time.time()
    e.preroll()
    # §53：預算可由環境變數放寬（多工／CI 機器）；預設 15 s（容器實測 3–8 s）
    budget = float(os.environ.get("TWIN_PREROLL_BUDGET_S", "15"))
    assert time.time() - t0 < budget
    assert e.clock.tick == e.params["preroll_ticks"]
    assert len(e.history) == 240
    assert e.history[0]["sim_minute"] == "06:00"
    assert e.history[-1]["sim_minute"] == "09:59"
    assert sum(h["good_units"] for h in e.history) == e.good
    assert e.provenance["initial_snapshot_id"] == f"SNAP-PREROLL-42-{e.clock.tick}"


def test_event_bus_after_seq():
    """ADR-004: after_seq 為 exclusive；超出窗口回報不完整。"""
    e = FactoryEngine(seed=42)
    e.run_ticks(20_000)
    last = e.bus.seq
    evs, complete = e.bus.after(last - 10)
    assert complete and len(evs) == 10
    assert [x["seq"] for x in evs] == list(range(last - 9, last + 1))
    evs2, complete2 = e.bus.after(last)
    assert complete2 and evs2 == []


def test_rng_stream_isolation():
    """telemetry 顯示抽樣不影響生產邏輯（stream 隔離）。"""
    a, b = FactoryEngine(seed=42), FactoryEngine(seed=42)
    a.rng.stream("telemetry").random()      # 額外消費 telemetry stream
    a.run_ticks(30_000)
    b.run_ticks(30_000)
    assert a.created == b.created and a.good == b.good
    assert a.bus.seq == b.bus.seq


def test_bottleneck_is_machine_tending():
    """ADR-007: 自然瓶頸應為 Machine Tending（利用率最高）。"""
    e = FactoryEngine(seed=42)
    e.run_ticks(72_000)      # 2 模擬小時
    util = {k: sum(s["busy_time"] for s in e.cells[k]["stations"])
            / len(e.cells[k]["stations"]) for k in e.cells}
    assert max(util, key=util.get) == "machine_tending"
