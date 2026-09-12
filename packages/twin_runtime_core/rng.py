"""每個 Engine 獨立持有的 RNG 服務（ADR-005）。

- 禁止全域 `random`；每個 Engine 一個 RngService。
- 具名 stream（"process"、"telemetry"…）各自獨立，避免顯示用抽樣影響生產邏輯。
- dump/load 保存完整 internal state（What-if 分支必須複製，不是 re-seed）。
"""
from __future__ import annotations

import random


class RngService:
    def __init__(self, seed: int):
        self.seed = seed
        self._streams: dict[str, random.Random] = {}

    def stream(self, name: str) -> random.Random:
        if name not in self._streams:
            # 子 seed 由 (seed, name) 決定，與建立順序無關 → 確定性
            child = random.Random(f"{self.seed}:{name}").getrandbits(64)
            self._streams[name] = random.Random(child)
        return self._streams[name]

    # ---- snapshot 協定（JSON-safe） ----
    def dump_state(self) -> dict:
        out = {"seed": self.seed, "streams": {}}
        for name, r in self._streams.items():
            version, internal, gauss = r.getstate()
            out["streams"][name] = {"version": version, "internal": list(internal), "gauss": gauss}
        return out

    def load_state(self, d: dict) -> None:
        self.seed = d["seed"]
        self._streams = {}
        for name, st in d["streams"].items():
            r = random.Random()
            r.setstate((st["version"], tuple(st["internal"]), st["gauss"]))
            self._streams[name] = r
