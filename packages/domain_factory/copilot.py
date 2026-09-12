"""AI Operations Copilot（§22）。

架構分三層，嚴格守住 §22.3：

1. **意圖路由（規則式、確定性）**：把自由提問對映到 §22 問題清單的意圖。
2. **回答器（規則式）**：每個意圖從真實 Twin State／API 資料組出
   ExplanationResult（§22.2 結構化 JSON）。事實只來自這裡。
3. **自然語言層（Ollama Adapter，選配）**：把結構化 JSON 改寫成流暢語句。
   LLM 只能改寫、不得新增事實；Ollama 不可用時自動退回確定性模板
   （`nl_source: "template"`）。引擎與測試完全不依賴 Ollama（§2 初期禁止
   付費/外部 AI 成為核心依賴）。
"""
from __future__ import annotations

import json
import os
import re

from .engine import CELL_IDS, CELL_ORDER, FactoryEngine
from .explanation import _base, explain_live
from .maintenance import assess

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")

# ---------------------------------------------------------------- 意圖路由（§22 問題清單）

INTENT_PATTERNS: list[tuple[str, str]] = [
    ("likely_fail", r"likely to fail|最.*(可能|容易).*(壞|故障)|maintenance.*priorit|維護.*(優先|先)"),
    ("what_if", r"what.*\bif\b|如果|會怎樣|(fails?|jams?|stops?) for|故障.*(分鐘|min)"),
    ("bottleneck", r"bottleneck|瓶頸"),
    ("oee", r"oee|稼動|效率.*(掉|降|下降)|why.*(drop|decreas)"),
    ("order_on_time", r"on time|來得及|準時|如期|finish.*order|訂單"),
    ("defect", r"defect|缺陷|不良|quality|品質"),
    ("energy", r"energy|能耗|用電|耗電|節能"),
    ("status", r"status|狀態|現在|overview|總覽"),
]


def route(question: str) -> str:
    q = question.lower()
    for intent, pat in INTENT_PATTERNS:
        if re.search(pat, q):
            return intent
    return "status"


def extract_target(question: str) -> tuple[str, str, float]:
    """what_if 意圖的參數抽取：(failure_type, target_id, duration_sec)。"""
    q = question.upper()
    m = re.search(r"\b(R-\d{2}|C-0[1-3]|[WAMQ]-0\d)\b", q)
    target = m.group(1) if m else "R-09"
    ft = "conveyor_jam" if target.startswith("C-") else \
        "minor_stop" if target[0] in "WAMQ" else "tool_failure"
    dm = re.search(r"(\d+)\s*(?:MIN|分鐘)", q)
    dur = int(dm.group(1)) * 60 if dm else 1800
    dur = max(60, min(dur, 7200))            # 與 whatif.WHATIF_LIMITS 一致（1 min–2 h）
    return ft, target, float(dur)


# ---------------------------------------------------------------- 回答器（事實來源）

def answer_bottleneck(eng: FactoryEngine) -> dict:
    runtime = max(1.0, eng.clock.sim_seconds - eng.downtime_sec)
    util = {k: sum(s["busy_time"] for s in eng.cells[k]["stations"])
            / (runtime * len(eng.cells[k]["stations"])) for k in CELL_ORDER}
    top = max(util, key=lambda k: util[k])
    ranked = sorted(util.items(), key=lambda kv: -kv[1])
    return _base(
        f"The current bottleneck is {CELL_IDS[top]} (utilization {util[top]:.1%}).",
        f"{CELL_IDS[top]} has the highest station utilization and paces the whole line.",
        [f"{CELL_IDS[k]} utilization {v:.1%}" for k, v in ranked],
        [f"Only improving {CELL_IDS[top]}'s station cycle or adding a parallel station "
         f"will raise line output",
         "Improvements at non-bottleneck cells will not increase total throughput"],
        0.9, ["Utilization = busy_time / (runtime × stations), from engine accumulators"],
        "The bottleneck sets the theoretical capacity ceiling", "None", )


def answer_oee(eng: FactoryEngine) -> dict:
    k = eng.kpis()
    o = k["oee"]
    worst = min([("Availability", o["availability"]), ("Performance", o["performance"]),
                 ("Quality", o["quality"])], key=lambda x: x[1])
    return _base(
        f"OEE is {o['oee']:.1%} (A {o['availability']:.1%} × P {o['performance']:.1%} × "
        f"Q {o['quality']:.1%}) against a {o['target_oee']:.0%} target. "
        f"The largest loss currently comes from {worst[0]}.",
        f"{worst[0]} = {worst[1]:.1%} is the lowest of the three factors.",
        [f"Accumulated bottleneck downtime {k['downtime_sec']:.0f}s (minor stops / faults)",
         f"Actual output {k['total_output']} units vs takt {k['takt_time_sec']}s",
         f"FPY {k['first_pass_yield']:.2%}, {k['defect_units']} units failed inspection"],
        ["Address the bottleneck cell's downtime sources first" if worst[0] == "Availability"
         else "Review bottleneck cycle time and blocked/starved intervals"
         if worst[0] == "Performance"
         else "Review which stations concentrate the inspection failures"],
        0.85, ["All three OEE factors derive from the same raw event stream (§18.2)"],
        f"If {worst[0]} returned to 100%, the OEE ceiling would be "
        f"{o['oee'] / max(worst[1], 1e-9):.1%}", "None", )


def answer_order_on_time(eng: FactoryEngine) -> dict:
    k = eng.kpis()
    p = eng.params
    shift_sec = p["shift"]["length_hours"] * 3600
    remaining_sec = max(0.0, shift_sec - eng.clock.sim_seconds)
    remaining_units = max(0, k["target_good_units"] - k["good_units"])
    projected = k["throughput_uph"] * remaining_sec / 3600
    margin = projected - remaining_units
    ok = margin >= 0
    return _base(
        (f"On pace to finish on schedule: {remaining_units} units remain, and the "
         f"remaining {remaining_sec/3600:.1f} h should yield ≈{projected:.0f} units "
         f"(margin {margin:+.0f}).") if ok else
        (f"At the current rate the order will fall short by {-margin:.0f} units: "
         f"{remaining_units} remain but only ≈{projected:.0f} can be produced in the "
         f"remaining time."),
        f"Linear projection: current throughput {k['throughput_uph']} u/h × remaining time.",
        [f"Completed {k['good_units']} / {k['target_good_units']}",
         f"Remaining shift time {remaining_sec/3600:.2f} h",
         f"Current throughput {k['throughput_uph']} u/h "
         f"(bottleneck theoretical max 160 u/h)"],
        ["Hold the current pace" if ok
         else "Consider shortening changeovers or extending the shift",
         "Any bottleneck stoppage longer than ~10 min will consume the margin" if ok
         else "Use What-if to evaluate recovery options"],
        0.8, ["Linear projection assumes no major failure in the remaining time; "
              "random minor stops are not modeled in the margin"],
        f"Projected end-of-shift good units ≈{k['good_units'] + projected:.0f}",
        "A projection, not a guarantee; a major failure changes the conclusion", )


def answer_likely_fail(eng: FactoryEngine) -> dict:
    rows = assess(eng)
    top = rows[0]
    return _base(
        f"{top['robot_id']} ({top['station_id']}) is most likely to need maintenance: "
        f"health {top['health_score']}, risk {top['maintenance_risk']:.0%}, "
        f"RUL ≈{top['rul_shifts']} shifts; recommended window: "
        f"{top['recommended_window']}.",
        f"{top['robot_id']} has the highest tool wear "
        f"({top['completions']} completions accumulated).",
        [f"{r['robot_id']}: health {r['health_score']} · risk {r['maintenance_risk']:.0%} · "
         f"RUL {r['rul_shifts']} shifts" for r in rows[:4]],
        [f"Schedule a tool inspection for {top['robot_id']} at the "
         f"'{top['recommended_window']}' window",
         "Cell capacity drops during maintenance — evaluate the impact with What-if first"],
        0.8, [f"V1 method: {top['method']}; wear rate taken from actual completions"],
        "Early maintenance avoids an unplanned stop", "Linear model excludes sudden failures", )


def answer_defect(eng: FactoryEngine) -> dict:
    k = eng.kpis()
    return _base(
        f"Defect rate {k['defect_rate']:.2%} (FPY {k['first_pass_yield']:.2%}); "
        f"{k['defect_units']} units failed inspection, {k['rework_units']} in rework.",
        "Failures are judged at Vision Inspection and all enter the rework loop (no scrap).",
        [f"First-pass inspections {eng.first_pass_inspections}, "
         f"failed {eng.first_pass_fails}",
         "Recent defect types: " + (", ".join(
             f"{t}×{c}" for t, c in sorted(
                 {r["ground_truth"]: sum(1 for x in eng.recent_inspections
                                         if x["ground_truth"] == r["ground_truth"])
                  for r in eng.recent_inspections
                  if r["ground_truth"] != "ok"}.items())) or "none in window"),
         f"Rework buffer {len(eng.rework)}/"
         f"{eng.params['buffers']['rework_area']['capacity']}",
         f"Cumulative rework events {eng.rework_events}"],
        ["A rate near the configured 0.68% is normal; investigate stations only if it "
         "stays above 1%"],
        0.85, ["Inspection verdicts come from a demo-grade ONNX classifier on synthetic "
               "parts (§16.4), not an industrial vision system"],
        "The rework loop slightly increases WIP and inspection load", "None", )


def answer_energy(eng: FactoryEngine) -> dict:
    k = eng.kpis()
    e = eng.params["energy"]
    idle_robots = sum(1 for key in CELL_ORDER for s in eng.cells[key]["stations"]
                      if s["part_id"] is None and s["fault_kind"] is None)
    idle_share = (e["base_load_kw"] + idle_robots * e["robot"]["idle"]) / \
        max(k["energy_kw_current"], 1e-9)
    return _base(
        f"Cumulative {k['energy_kwh_total']} kWh at {k['energy_kwh_per_unit']} kWh/unit; "
        f"current draw {k['energy_kw_current']} kW, of which roughly {idle_share:.0%} "
        f"is base load and idle.",
        "Idle energy at the non-bottleneck cells (Welding/Assembly utilization <50%) "
        "is the main improvable item.",
        [f"Peak demand {k['peak_demand_kw']} kW",
         f"{idle_robots} robots currently idle ({e['robot']['idle']} kW each)",
         f"Base load {e['base_load_kw']} kW"],
        ["Put non-bottleneck stations into standby during low-load periods",
         "Stagger equipment start-up to reduce peak demand"],
        0.75, [f"Energy model uses simulation parameters ({eng.provenance.get('parameter_set_id', '?')}), not measurements"],
        f"Halving idle energy would save an estimated "
        f"{(e['base_load_kw']*0.2 + idle_robots*e['robot']['idle']/2)*8:.0f} kWh per shift",
        "Simulation estimate; a real plant needs metering", )


ANSWERERS = {
    "bottleneck": answer_bottleneck, "oee": answer_oee,
    "order_on_time": answer_order_on_time, "likely_fail": answer_likely_fail,
    "defect": answer_defect, "energy": answer_energy, "status": explain_live,
}

SUGGESTED_QUESTIONS = [
    "Which station is the bottleneck?", "Why is OEE dropping?",
    "Can we finish the production order on time?", "Which robot is most likely to fail?",
    "How can energy consumption be reduced?", "What happens if R-09 fails for 30 minutes?",
]


# ---------------------------------------------------------------- 自然語言層

def render_template(x: dict) -> str:
    """確定性模板（Ollama 不可用時的 fallback）。只重排 JSON 內容，零新增事實。"""
    lines = [x["summary"], f"Primary cause: {x['primary_cause']}"]
    lines += [f"• {ev}" for ev in x["evidence"][:4]]
    if x["recommended_actions"]:
        lines.append("Recommended: " + "; ".join(x["recommended_actions"][:2]))
    lines.append(f"(confidence {x['confidence']:.0%} | simulation result | "
                 f"human approval required)")
    return "\n".join(lines)


async def render_nl(x: dict, question: str) -> tuple[str, str]:
    """回傳 (text, source)。source ∈ {"ollama", "template"}。"""
    try:
        import httpx
        prompt = (
            "You are a factory operations assistant. Rewrite the structured analysis "
            "below as a fluent 3-5 sentence English answer. Rules: use ONLY the facts "
            "and numbers present in the JSON — never add, guess, or drop key numbers; "
            "end by stating the confidence level and that this is a simulation result "
            "requiring human approval.\n"
            f"User question: {question}\nAnalysis JSON: {json.dumps(x, ensure_ascii=False)}"
        )
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(f"{OLLAMA_URL}/api/generate",
                                  json={"model": OLLAMA_MODEL, "prompt": prompt,
                                        "stream": False})
            r.raise_for_status()
            text = r.json().get("response", "").strip()
            if text:
                return text, "ollama"
    except Exception:
        pass
    return render_template(x), "template"


async def ask(eng: FactoryEngine, question: str) -> dict:
    """完整流程：路由 → 規則式回答 → 自然語言層。"""
    intent = route(question)
    if intent == "what_if":
        # what_if 需要跑 scenario，由 API 層處理（需要 lock 與 registry）
        return {"intent": intent, "needs_scenario": True,
                "params": dict(zip(("failure_type", "target_id", "duration_sec"),
                                   extract_target(question)))}
    x = ANSWERERS[intent](eng)
    text, source = await render_nl(x, question)
    return {"intent": intent, "needs_scenario": False,
            "explanation": x, "nl_text": text, "nl_source": source}
