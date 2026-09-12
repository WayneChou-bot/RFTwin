"""§50 佈局單一來源：引擎常數來自 JSON、前端副本與 config 完全一致、provenance 帶 layout hash。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages"))

ROOT = Path(__file__).resolve().parents[1]

from domain_factory import layout as L  # noqa: E402
from domain_factory.engine import AMR_DOCKS, AMR_HOME, FactoryEngine, OBSTACLE_SITES  # noqa: E402


def test_frontend_copy_matches_config():
    src = json.loads((ROOT / "config" / "factory_layout.json").read_text(encoding="utf-8"))
    dst = json.loads((ROOT / "frontend" / "src" / "layout" / "factory_layout.json").read_text(encoding="utf-8"))
    assert src == dst, "run scripts/sync_layout.py"


def test_engine_geometry_comes_from_layout_json():
    cfg = json.loads((ROOT / "config" / "factory_layout.json").read_text(encoding="utf-8"))
    for k, v in cfg["amr"]["docks"].items():
        assert AMR_DOCKS[k] == (v[0], v[1])
    for k, v in cfg["amr"]["homes"].items():
        assert AMR_HOME[k] == (v[0], v[1])
    for k, v in cfg["obstacle_sites"].items():
        assert OBSTACLE_SITES[k] == (v["x"], v["z"], v["label"])
    assert L.AMR_CORRIDOR_Z == cfg["amr"]["corridor_z"]
    assert set(L.CELL_X) == set(cfg["cells"])


def test_provenance_carries_layout_hash():
    e = FactoryEngine(run_id="T", seed=42)
    assert e.provenance["layout_id"] == L.LAYOUT_ID
    assert e.provenance["layout_hash"] == L.layout_hash(L.LAYOUT)
    assert e.provenance["layout_hash"].startswith("sha256:")
