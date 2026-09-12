"""§43 Local Demo Fixture — 由 Python 權威引擎預先產生的確定性 Replay 資料。

前端在 Backend 不可用時播放這些檔案（LOCAL_DEMO 模式）；前端只負責照
模擬時間播放與插值，不重新判斷任何生產規則（§43.3 — 不得在
TypeScript 重寫第二套引擎）。

輸出（frontend/public/demo/，build 時隨 dist 發佈）：
  manifest.json          demo 識別、seed、schema/engine 版本、長度、產生方式
  initial_snapshot.json  完整 SnapshotMessage（含 history_minutes，schema 驗證）
  snapshots.ndjson       每秒 1 筆「輕量」snapshot（history_minutes=[]，仍為合法
                         SnapshotMessage；播放器沿用最近一次非空 history）
  events.ndjson          有序 EventMessage 流（wire 格式，seq 連續）
  panels.json               REST 面板資料快照（maintenance／energy breakdown／
                         opportunities／flow insight+history／vision metrics／
                         inspection feed），供離線時的資料分頁使用
  inspection/*.png       預先渲染的檢測影像

用法：python scripts/generate_demo.py [--duration 300] [--seed 42]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT))

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.maintenance import assess  # noqa: E402
from domain_factory.models import SnapshotMessage  # noqa: E402
from domain_factory.serialize import amr_patch_message, snapshot_message  # noqa: E402
from domain_factory.vision import VisionInspector, render_part_image, to_png  # noqa: E402

OUT = ROOT / "frontend" / "public" / "demo"


def _wire_event(eng: FactoryEngine, ev: dict) -> dict:
    return {"type": "event", "schema_version": eng.provenance["schema_version"],
            "run_id": eng.run_id, "seq": ev["seq"], "sim_tick": ev["sim_tick"],
            "sim_time": ev["sim_time"], "generated_at": "1970-01-01T00:00:00Z",
            "event": ev}


def _light(snap: dict) -> dict:
    """輕量 snapshot：去掉 history_minutes（仍為合法 SnapshotMessage）。"""
    s = json.loads(json.dumps(snap))
    s["state"]["history_minutes"] = []
    s["generated_at"] = "1970-01-01T00:00:00Z"          # 決定性輸出（牆鐘固定）
    return s


def generate(duration_sec: int = 300, seed: int = 42,
             out: Path | None = None) -> dict:
    out = out or OUT
    eng = FactoryEngine(run_id="LOCAL-DEMO", seed=seed)
    eng.preroll()

    out.mkdir(parents=True, exist_ok=True)
    (out / "inspection").mkdir(exist_ok=True)

    initial = snapshot_message(eng)
    initial["generated_at"] = "1970-01-01T00:00:00Z"
    SnapshotMessage.model_validate(initial)             # 與 Live 完全同一 schema
    (out / "initial_snapshot.json").write_text(
        json.dumps(initial, ensure_ascii=False), encoding="utf-8")

    # §48 內建劇本（決定性；讓離線 demo 也能展示空間障礙物與繞行）
    scenarios = [{"t": 45, "failure_type": "zone_obstacle",
                  "target_id": "corridor_west", "duration_sec": 90}]
    snaps, events, patches = [], [], []
    amr_prev: dict = {}
    for t in range(duration_sec):                        # 每秒：10 ticks + 1 snapshot
        before = eng.bus.seq
        for sc in scenarios:
            if sc["t"] == t:
                eng.inject(sc["failure_type"], sc["target_id"], sc["duration_sec"])
        for _k in range(10):                             # §50：每 tick 一則 amr_patch（10 Hz）
            eng.step()
            pm = amr_patch_message(eng, amr_prev)
            if pm is not None:
                pm["generated_at"] = "1970-01-01T00:00:00Z"
                patches.append(pm)
        new_events, _c = eng.bus.after(before)
        events.extend(_wire_event(eng, ev) for ev in new_events)
        light = _light(snapshot_message(eng))
        SnapshotMessage.model_validate(light)
        snaps.append(light)
    eng.check_conservation()

    (out / "snapshots.ndjson").write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in snaps), encoding="utf-8")
    (out / "events.ndjson").write_text(
        "\n".join(json.dumps(e, ensure_ascii=False) for e in events), encoding="utf-8")
    (out / "amr_patches.ndjson").write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in patches), encoding="utf-8")

    # ---- aux：資料分頁的離線快照（時間點=demo 結束）----
    vision = VisionInspector()
    feed = []
    for rec in reversed(list(eng.recent_inspections)[-8:]):
        r = vision.infer(seed, rec["part_id"], rec["ground_truth"])
        r["sim_time"] = rec["sim_time"]
        r["first_pass"] = rec["first_pass"]
        r["image_url"] = f"demo/inspection/{rec['part_id']}.png"
        feed.append(r)
        (out / "inspection" / f"{rec['part_id']}.png").write_bytes(
            to_png(render_part_image(seed, rec["part_id"], rec["ground_truth"])))
    n = len(feed)
    agree = sum(1 for r in feed if r["agreement"])
    aux = {
        "maintenance": assess(eng),
        "energy_breakdown": eng.energy_breakdown(),
        "energy_opportunities": eng.energy_opportunities(),
        "flow_insight": eng.flow_insight(),
        "flow_history": eng.flow_history[-120:],
        "amr": eng.amr_kpis(),
        "inspection_recent": feed,
        "vision_metrics": {"window": n,
                           "online_agreement": round(agree / n, 4) if n else None,
                           "false_rejects": 0, "false_accepts": 0,
                           "model_source": vision.source,
                           "model_meta": getattr(vision, "meta", {})},
        "scenarios": [],               # what-if 情境（demo 無；/api/scenarios 對應）
        "demo_script": scenarios,      # §48 fixture 內建注入劇本（說明用）
    }
    (out / "panels.json").write_text(json.dumps(aux, ensure_ascii=False), encoding="utf-8")

    manifest = {
        "demo_id": f"factory-local-seed{seed}",
        "seed": seed,
        "parameter_set_id": eng.provenance["parameter_set_id"],
        "parameter_hash": eng.provenance["parameter_hash"],
        "schema_version": eng.provenance["schema_version"],
        "engine_version": eng.provenance["engine_version"],
        "duration_seconds": duration_sec,
        "tick_ms": eng.params["tick_ms"],
        "snapshot_hz": 1,
        "event_count": len(events),
        "amr_patch_count": len(patches),                 # §50 10 Hz 位置增量
        "first_seq": initial["seq"],
        "last_seq": events[-1]["seq"] if events else initial["seq"],
        "generated_by": "python-twin-engine (scripts/generate_demo.py)",
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=int, default=300)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    m = generate(a.duration, a.seed)
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"demo fixture: {m['demo_id']} · {m['duration_seconds']}s · "
          f"{m['event_count']} events · {total / 1e6:.1f} MB → {OUT}")
