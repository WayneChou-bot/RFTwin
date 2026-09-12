"""Hugging Face Space (Gradio SDK, free CPU) entry point for the RFTwin backend.

Docker Spaces are paid; the Gradio SDK is free and simply runs `python app.py`. So this file:
  1. downloads the RFTwin source (GitHub tarball, ref from RFTWIN_REF, default main) on start-up,
  2. imports the FastAPI app (REST + WebSocket simulation backend) from it,
  3. mounts a one-screen Gradio status page at "/" so the Space shows something useful,
  4. serves everything with uvicorn on port 7860 (the port Spaces expose).
The 3D frontend lives on Vercel and points here via VITE_API_BASE; the backend only accepts
cross-site calls from origins listed in the Space variable TWIN_CORS_ORIGINS.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO = os.environ.get("RFTWIN_REPO", "WayneChou-bot/RFTwin")
REF = os.environ.get("RFTWIN_REF", "main")
PORT = int(os.environ.get("PORT", "7860"))
WORK = Path(os.environ.get("RFTWIN_WORK", "/tmp/rftwin"))
os.environ.setdefault("TWIN_RATE_LIMIT", "1")
os.environ.setdefault("TWIN_HEALTH_STALL_S", "10")
os.environ.setdefault("TWIN_XFF", "first")


def fetch_source() -> Path:
    """Download and extract the repo tarball (no git needed). RFTWIN_SRC=<dir> skips the download."""
    if os.environ.get("RFTWIN_SRC"):
        return Path(os.environ["RFTWIN_SRC"]).resolve()
    url = f"https://github.com/{REPO}/archive/refs/heads/{REF}.tar.gz"
    print(f"[space] fetching {url}", flush=True)
    data = urllib.request.urlopen(url, timeout=120).read()
    WORK.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        tar.extractall(WORK, filter="data")
    root = next(p for p in WORK.iterdir() if p.is_dir() and p.name.startswith("RFTwin-"))
    print(f"[space] source ready: {root}", flush=True)
    return root


ROOT = fetch_source()
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages"))

import gradio as gr                                   # noqa: E402  (preinstalled by the Space SDK)
import uvicorn                                        # noqa: E402
from apps.factory_backend.main import app             # noqa: E402  FastAPI app: /api/*, /ws, /api/health

FRONTEND = os.environ.get("RFTWIN_FRONTEND_URL", "")


def status() -> str:
    from apps.factory_backend.main import RUNS, HEALTH  # noqa: E402
    eng = RUNS.get("LIVE-001")
    info = {
        "service": "Robot Factory Digital Twin — simulation backend",
        "repo": f"https://github.com/{REPO}", "ref": REF,
        "run_id": eng.run_id if eng else None,
        "sim_time": eng.clock.sim_time_iso() if eng else None,
        "seq": eng.bus.seq if eng else None,
        "engine_version": eng.provenance.get("engine_version") if eng else None,
        "loop_errors": HEALTH.get("loop_errors"),
        "endpoints": ["/api/health", "/api/runs/LIVE-001/snapshot", "/ws"],
    }
    return json.dumps(info, indent=2, ensure_ascii=False)


with gr.Blocks(title="RFTwin backend") as demo:
    gr.Markdown("## Robot Factory Digital Twin — simulation backend\n"
                "This Space only runs the authoritative engine (REST + WebSocket). "
                + (f"Open the 3D dashboard: **[{FRONTEND}]({FRONTEND})**" if FRONTEND else
                   "The 3D dashboard is deployed separately (Vercel)."))
    out = gr.Code(label="status", language="json")
    btn = gr.Button("Refresh status")
    btn.click(status, outputs=out)
    demo.load(status, outputs=out)

app = gr.mount_gradio_app(app, demo, path="/")       # /api and /ws are registered first → keep precedence

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, ws="wsproto")
