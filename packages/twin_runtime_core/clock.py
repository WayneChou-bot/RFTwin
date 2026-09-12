"""固定 tick 模擬時鐘（ADR-005）。不得以牆鐘推動狀態轉移。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


class SimulationClock:
    def __init__(self, tick_ms: int, shift_start_iso: str):
        self.tick_ms = tick_ms
        self.tick = 0
        self._t0 = datetime.fromisoformat(shift_start_iso)

    @property
    def dt(self) -> float:
        """每 tick 秒數。"""
        return self.tick_ms / 1000.0

    @property
    def sim_seconds(self) -> float:
        return self.tick * self.dt

    @property
    def sim_time(self) -> datetime:
        return self._t0 + timedelta(seconds=self.sim_seconds)

    @property
    def sim_time_iso(self) -> str:
        return self.sim_time.isoformat()

    @property
    def sim_minute_of_day(self) -> int:
        t = self.sim_time
        return t.hour * 60 + t.minute

    def advance(self) -> None:
        self.tick += 1

    # ---- snapshot 協定 ----
    def dump_state(self) -> dict:
        return {"tick": self.tick, "tick_ms": self.tick_ms, "t0": self._t0.isoformat()}

    def load_state(self, d: dict) -> None:
        assert d["tick_ms"] == self.tick_ms
        self.tick = d["tick"]
        self._t0 = datetime.fromisoformat(d["t0"])


def wall_now_iso() -> str:
    """牆鐘時間（只用於 generated_at，絕不用於模擬）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
