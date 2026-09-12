"""§43 Local Demo Fixture：由 Python 引擎產生、與 Live 同 schema、確定性。"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT))

from domain_factory.models import EventMessage, SnapshotMessage  # noqa: E402
from scripts.generate_demo import generate  # noqa: E402


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    out = tmp_path_factory.mktemp("demo")
    manifest = generate(duration_sec=10, seed=42, out=out)
    return out, manifest


def test_manifest_and_provenance(demo):
    out, m = demo
    assert m["generated_by"].startswith("python-twin-engine")
    assert m["schema_version"] == "1.0"
    assert m["seed"] == 42 and m["tick_ms"] == 100
    assert (out / "manifest.json").exists()


def test_snapshots_and_events_are_wire_schema(demo):
    """驗收 §43.11-5：Local 與 Live 共用相同 JSON Schema。"""
    out, _ = demo
    init = json.loads((out / "initial_snapshot.json").read_text(encoding="utf-8"))
    SnapshotMessage.model_validate(init)
    assert init["state"]["history_minutes"]        # initial 含完整歷史
    for line in (out / "snapshots.ndjson").read_text(encoding="utf-8").splitlines():
        SnapshotMessage.model_validate(json.loads(line))
    for line in (out / "events.ndjson").read_text(encoding="utf-8").splitlines():
        EventMessage.model_validate(json.loads(line))


def test_sequence_contiguous(demo):
    out, m = demo
    init = json.loads((out / "initial_snapshot.json").read_text(encoding="utf-8"))
    seqs = [json.loads(l)["seq"] for l in
            (out / "events.ndjson").read_text(encoding="utf-8").splitlines()]
    if seqs:
        assert seqs[0] == init["seq"] + 1
        assert seqs == list(range(seqs[0], seqs[0] + len(seqs)))
        assert m["last_seq"] == seqs[-1]


def test_aux_panels_present(demo):
    out, _ = demo
    aux = json.loads((out / "panels.json").read_text(encoding="utf-8"))
    for k in ("maintenance", "energy_breakdown", "energy_opportunities",
              "flow_insight", "flow_history", "amr", "inspection_recent",
              "vision_metrics"):
        assert k in aux
    for r in aux["inspection_recent"]:
        assert (out / r["image_url"].replace("demo/", "")).exists()


def test_deterministic(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    generate(duration_sec=5, seed=42, out=a)
    generate(duration_sec=5, seed=42, out=b)
    for name in ("initial_snapshot.json", "snapshots.ndjson", "events.ndjson",
                 "manifest.json"):
        assert (a / name).read_bytes() == (b / name).read_bytes(), name
