"""§50 佈局單一來源（WareTwin 借鏡）：config/factory_layout.json 載入與 hash。

引擎的 AMR 空間模型（dock／充電位／走廊／障礙預設位置／樓面範圍）與前端場景
共用同一份 JSON；前端副本由 scripts/sync_layout.py 產生，tests/test_layout.py
驗證兩份一致。幾何不再以常數鏡射在兩邊。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

LAYOUT_PATH = Path(__file__).resolve().parents[2] / "config" / "factory_layout.json"


def load_layout(path: Path = LAYOUT_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def layout_hash(layout: dict) -> str:
    canon = json.dumps(layout, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


LAYOUT = load_layout()
LAYOUT_ID: str = LAYOUT["layout_id"]
LAYOUT_HASH: str = layout_hash(LAYOUT)

CELL_X: dict[str, float] = {cid: float(c["x"]) for cid, c in LAYOUT["cells"].items()}
AMR_DOCKS: dict[str, tuple[float, float]] = {
    k: (float(v[0]), float(v[1])) for k, v in LAYOUT["amr"]["docks"].items()}
AMR_HOME: dict[str, tuple[float, float]] = {
    k: (float(v[0]), float(v[1])) for k, v in LAYOUT["amr"]["homes"].items()}
AMR_CORRIDOR_Z: float = float(LAYOUT["amr"]["corridor_z"])
FLOOR: dict[str, float] = {k: float(v) for k, v in LAYOUT["amr"]["floor"].items()}
EVADE: dict[str, float] = {k: float(v) for k, v in LAYOUT["amr"]["evade_bounds"].items()}
OBSTACLE_SITES: dict[str, tuple[float, float, str]] = {
    k: (float(v["x"]), float(v["z"]), str(v["label"]))
    for k, v in LAYOUT["obstacle_sites"].items()}
