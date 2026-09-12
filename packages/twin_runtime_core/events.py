"""Event Bus（§15、ADR-004）。

只有 Event 遞增 seq；seq 在寫入的同一步驟分配。保留最近 N 筆供 after_seq 補送。
"""
from __future__ import annotations

from collections import deque


class EventBus:
    def __init__(self, run_id: str, retention: int = 5000):
        self.run_id = run_id
        self.seq = 0                      # 最後一筆已分配的 event seq
        self.retention = retention
        self._buffer: deque[dict] = deque(maxlen=retention)

    def emit(self, *, sim_tick: int, sim_time: str, source_type: str, source_id: str,
             event_type: str, severity: str, message: str,
             line_id: str | None = None, cell_id: str | None = None,
             value: float | None = None, threshold: float | None = None) -> dict:
        self.seq += 1
        ev = {
            "event_id": f"EVT-{self.seq}", "run_id": self.run_id, "seq": self.seq,
            "sim_tick": sim_tick, "sim_time": sim_time,
            "source_type": source_type, "source_id": source_id,
            "event_type": event_type, "severity": severity,
            "line_id": line_id, "cell_id": cell_id,
            "message": message, "value": value, "threshold": threshold,
            "acknowledged": False,
        }
        self._buffer.append(ev)
        return ev

    def after(self, after_seq: int, limit: int = 500) -> tuple[list[dict], bool]:
        """回傳 seq > after_seq 的事件（升冪）。第二值 = 是否完整（False = 超出保留窗口）。"""
        if self._buffer and after_seq < self._buffer[0]["seq"] - 1:
            return [], False
        out = [e for e in self._buffer if e["seq"] > after_seq]
        return out[:limit], True

    def recent(self, n: int = 8) -> list[dict]:
        return list(self._buffer)[-n:]

    # ---- snapshot 協定 ----
    def dump_state(self) -> dict:
        return {"run_id": self.run_id, "seq": self.seq, "buffer": list(self._buffer)}

    def load_state(self, d: dict) -> None:
        self.run_id = d["run_id"]
        self.seq = d["seq"]
        self._buffer = deque(d["buffer"], maxlen=self.retention)
