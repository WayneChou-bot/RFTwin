"""simulation_parameters.yaml 載入與 parameter_hash（ADR-009）。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import yaml

CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "simulation_parameters.yaml"


def load_params(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def parameter_hash(params: dict) -> str:
    """正規化（key 排序、無空白）JSON 的 SHA-256。由程式計算，不得手填。"""
    canon = json.dumps(params, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()
