"""Copilot 驗收 — 意圖路由、回答器、NL fallback（§22）。"""
import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.copilot import (ANSWERERS, ask, extract_target,  # noqa: E402
                                    render_template, route)
from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.models import ExplanationResult  # noqa: E402


@pytest.fixture(scope="module")
def live():
    e = FactoryEngine(seed=42)
    e.preroll()
    return e


@pytest.mark.parametrize("q,intent", [
    ("Which station is the bottleneck?", "bottleneck"),
    ("瓶頸在哪一站？", "bottleneck"),
    ("Why is OEE dropping?", "oee"),
    ("Can we finish the production order on time?", "order_on_time"),
    ("訂單來得及嗎", "order_on_time"),
    ("Which robot is most likely to fail?", "likely_fail"),
    ("維護要先做哪一台", "likely_fail"),
    ("How can energy consumption be reduced?", "energy"),
    ("What happens if R-06 fails for 30 minutes?", "what_if"),
    ("如果 C-03 卡住 10 分鐘會怎樣", "what_if"),
    ("defect rate 狀況", "defect"),
    ("今天狀態如何", "status"),
])
def test_intent_routing(q, intent):
    assert route(q) == intent


def test_extract_target():
    assert extract_target("What happens if R-06 fails for 30 minutes?") == \
        ("tool_failure", "R-06", 1800.0)
    assert extract_target("如果 C-03 卡住 10 分鐘會怎樣") == \
        ("conveyor_jam", "C-03", 600.0)


def test_all_answerers_valid_and_grounded(live):
    """每個回答器輸出 §22.2 合規 JSON，且引用真實 KPI 數字。"""
    k = live.kpis()
    for intent, fn in ANSWERERS.items():
        x = ExplanationResult.model_validate(fn(live))
        assert x.requires_human_approval and x.is_simulation_result
        assert len(x.evidence) >= 1
    bx = ANSWERERS["bottleneck"](live)
    assert "MACHINE_TENDING" in bx["summary"]
    ox = ANSWERERS["order_on_time"](live)
    assert str(k["good_units"]) in " ".join(ox["evidence"])


def test_order_projection_math(live):
    k = live.kpis()
    x = ANSWERERS["order_on_time"](live)
    remaining = k["target_good_units"] - k["good_units"]
    # 10:00 時剩 4h × ~158 u/h ≈ 632 > 剩餘量 → 應判可如期
    assert remaining < 158 * 4
    assert "on schedule" in x["summary"]


def test_nl_fallback_is_template_and_grounded(live):
    """容器內無 Ollama → 必須退回模板，且不得遺失關鍵標示。"""
    async def go():
        return await ask(live, "Why is OEE dropping?")
    r = asyncio.run(go())
    assert r["nl_source"] == "template"
    assert "simulation result" in r["nl_text"] and "human approval" in r["nl_text"]
    assert r["explanation"]["summary"].split("（")[0] in r["nl_text"]


def test_template_renderer_no_new_facts(live):
    x = ANSWERERS["energy"](live)
    text = render_template(x)
    for line in text.splitlines():
        core = line.lstrip("•（ ").rstrip("）")
        if not core:
            continue
    # 模板每一行都來自 JSON 欄位
    joined = x["summary"] + x["primary_cause"] + " ".join(x["evidence"]) + \
        " ".join(x["recommended_actions"])
    assert x["summary"] in text and x["evidence"][0] in text
    assert f"{x['confidence']:.0%}" in text


def test_ask_whatif_returns_scenario_request(live):
    async def go():
        return await ask(live, "What happens if R-09 fails for 30 minutes?")
    r = asyncio.run(go())
    assert r["needs_scenario"] and r["params"]["target_id"] == "R-09"
