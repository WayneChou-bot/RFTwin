"""Audit Log（§24）。所有重要操作與狀態轉移的可追溯紀錄。"""
from __future__ import annotations

from .clock import wall_now_iso


class AuditLog:
    def __init__(self, run_id: str, retention: int = 10000):
        self.run_id = run_id
        self.retention = retention
        self.entries: list[dict] = []

    def record(self, *, sim_time: str, actor: str, source: str, action: str,
               previous_state: str | None = None, new_state: str | None = None,
               reason: str | None = None, event_seq: int | None = None) -> None:
        self.entries.append({
            "sim_time": sim_time, "generated_at": wall_now_iso(),
            "run_id": self.run_id, "actor": actor, "source": source, "action": action,
            "previous_state": previous_state, "new_state": new_state,
            "reason": reason, "event_seq": event_seq,
        })
        if len(self.entries) > self.retention:
            self.entries = self.entries[-self.retention:]

    # ---- snapshot 協定 ----
    def dump_state(self) -> dict:
        return {"run_id": self.run_id, "entries": self.entries[-2000:]}

    def load_state(self, d: dict) -> None:
        self.run_id = d["run_id"]
        self.entries = list(d["entries"])
