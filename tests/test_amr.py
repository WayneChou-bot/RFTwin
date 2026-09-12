"""AMR 物流（§36.8）— 成品收集任務與出貨計數。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402


def test_finished_goods_collection():
    e = FactoryEngine(seed=42)
    e.run_ticks(40_000)          # ~67 模擬分鐘
    assert e.shipped > 0, "AMR 應執行成品收集"
    batch = e.params["amr"]["finished_collect_batch"]
    assert e.shipped % batch == 0
    assert e.shipped <= e.good
    ev = [x for x in e.bus.dump_state()["buffer"]
          if x["event_type"] == "TASK_COMPLETED" and "FG_COLLECT" in x["message"]]
    # buffer 可能已捲動，至少 shipped 計數與守恆成立
    e.check_conservation()


def test_raw_and_fg_tasks_coexist_deterministically():
    a, b = FactoryEngine(seed=42), FactoryEngine(seed=42)
    a.run_ticks(50_000)
    b.run_ticks(50_000)
    assert a.shipped == b.shipped and a.raw_stock == b.raw_stock
    assert a.state_hash() == b.state_hash()
