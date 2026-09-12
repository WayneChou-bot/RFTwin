"""Hugging Face Space (Gradio SDK · ZeroGPU, free) entry point for the RFTwin backend.

Docker Spaces are paid and CPU-basic needs PRO, so this runs on the free ZeroGPU tier. ZeroGPU only
supports the Gradio SDK and insists on (a) `demo.launch()` (not our own uvicorn) and (b) at least one
`@spaces.GPU` function. Our backend never touches a GPU, so:
  1. download the RFTwin source (GitHub tarball, ref RFTWIN_REF, default main) on start-up,
  2. import the FastAPI backend app (REST + WebSocket) from it,
  3. build a one-screen Gradio status page, launch it the normal Gradio way, and MOUNT the backend
     app under it — Gradio owns "/", the backend keeps /api/*, /ws, /api/health with its own
     middleware (rate limit / origin guard / body cap) intact,
  4. boot the engine (pre-roll + 100 ms ticker) in the background after the server is up
     (/api/health answers 503 until then — Gradio only waits 5 s for the port),
  5. keep a dummy `@spaces.GPU` function so the ZeroGPU runtime is satisfied (never called).
The 3D frontend lives on Vercel and points here via VITE_API_BASE; the backend only accepts
cross-site calls from origins listed in the Space variable TWIN_CORS_ORIGINS.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tarfile
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

import spaces                                          # noqa: F401  must be imported first on ZeroGPU

REPO = os.environ.get("RFTWIN_REPO", "WayneChou-bot/RFTwin")
REF = os.environ.get("RFTWIN_REF", "main")
WORK = Path(os.environ.get("RFTWIN_WORK", "/tmp/rftwin"))
FRONTEND = os.environ.get("RFTWIN_FRONTEND_URL", "")
os.environ.setdefault("TWIN_RATE_LIMIT", "1")
os.environ.setdefault("TWIN_HEALTH_STALL_S", "10")
os.environ.setdefault("TWIN_XFF", "first")
os.environ.setdefault("TWIN_WS_SEND_TIMEOUT_S", "3")   # HF proxy adds latency; 1 s (single-container default) is too tight

# The backend is validated with `uvicorn --ws wsproto` (the `websockets` implementation's 20 s keepalive ping
# drops busy connections after a few minutes). Gradio builds its own uvicorn.Config with ws="auto", so
# re-point "auto" at wsproto before launch — same protocol stack as the documented deployment.
import uvicorn.config as _uvconf                        # noqa: E402
_uvconf.WS_PROTOCOLS["auto"] = _uvconf.WS_PROTOCOLS["wsproto"]


def fetch_source() -> Path:
    """Download and extract the repo tarball (no git needed). RFTWIN_SRC=<dir> skips the download.
    Public repo: anonymous codeload URL. Private repo: set the Space *secret* GITHUB_TOKEN (a fine-grained
    token with read access to the repo) and the GitHub API tarball endpoint is used instead."""
    if os.environ.get("RFTWIN_SRC"):
        return Path(os.environ["RFTWIN_SRC"]).resolve()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        url = f"https://api.github.com/repos/{REPO}/tarball/{REF}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}",
                                                   "Accept": "application/vnd.github+json",
                                                   "User-Agent": "rftwin-space"})
    else:
        url = f"https://github.com/{REPO}/archive/refs/heads/{REF}.tar.gz"
        req = urllib.request.Request(url, headers={"User-Agent": "rftwin-space"})
    print(f"[space] fetching {url}", flush=True)
    try:
        data = urllib.request.urlopen(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        if e.code == 404 and not token:
            raise SystemExit(f"[space] {url} → 404. GitHub returns 404 for private repos: make "
                             f"{REPO} public, or add a Space secret GITHUB_TOKEN with read access.") from e
        raise
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        tar.extractall(WORK, filter="data")
    # codeload → "RFTwin-main/", API tarball → "WayneChou-bot-RFTwin-<sha>/": take the single top-level dir
    dirs = [p for p in WORK.iterdir() if p.is_dir()]
    if len(dirs) != 1:
        raise SystemExit(f"[space] unexpected tarball layout: {[d.name for d in dirs]}")
    print(f"[space] source ready: {dirs[0]}", flush=True)
    return dirs[0]


ROOT = fetch_source()
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages"))

import gradio as gr                                                  # noqa: E402
from apps.factory_backend import main as backend                     # noqa: E402
from apps.factory_backend.main import app as twin_app                # noqa: E402  /api/*, /ws, /api/health


@spaces.GPU                                   # ZeroGPU requires one decorated function; never invoked
def _zero_gpu_placeholder() -> str:
    return "this backend runs on CPU"


async def _boot() -> None:
    """Engine pre-roll (4–10 s of CPU) runs in a worker thread AFTER the server is up: Gradio only waits
    5 s for the port to answer, so pre-rolling inside the lifespan made it conclude the port was dead
    ("Cannot find empty port"). Until this finishes /api/health answers 503 "engine warming up"."""
    import asyncio
    import time
    eng = await asyncio.to_thread(backend._build_live, "LIVE-001")
    backend.RUNS["LIVE-001"] = eng
    backend.HEALTH["last_progress"] = time.monotonic()
    backend._ticker_task = asyncio.create_task(backend._ticker())
    print(f"[space] engine ready: {eng.run_id} seq={eng.bus.seq}", flush=True)


@asynccontextmanager
async def outer_lifespan(server_app):
    """Runs inside Gradio's server: mount the twin backend (Gradio's own routes are already registered, so
    "/" and /gradio_api/* stay Gradio's; /api/*, /ws fall through to the backend with its middleware intact),
    then kick off the engine boot without blocking start-up."""
    import asyncio
    server_app.mount("/", twin_app, name="twin")
    print("[space] twin backend mounted: /api/*, /ws", flush=True)
    boot = asyncio.create_task(_boot())
    yield
    boot.cancel()
    task = getattr(backend, "_ticker_task", None)
    if task is not None:
        task.cancel()


def status() -> str:
    eng = backend.RUNS.get("LIVE-001")
    return json.dumps({
        "service": "Robot Factory Digital Twin — simulation backend",
        "repo": f"https://github.com/{REPO}", "ref": REF,
        "run_id": eng.run_id if eng else None,
        "sim_time": eng.clock.sim_time_iso if eng else None,
        "seq": eng.bus.seq if eng else None,
        "engine_version": eng.provenance.get("engine_version") if eng else None,
        "loop_errors": backend.HEALTH.get("loop_errors"),
        "endpoints": ["/api/health", "/api/runs/LIVE-001/snapshot", "/ws"],
    }, indent=2, ensure_ascii=False)


with gr.Blocks(title="RFTwin backend") as demo:
    gr.Markdown("## Robot Factory Digital Twin — simulation backend\n"
                "This Space only runs the authoritative engine (REST + WebSocket). "
                + (f"Open the 3D dashboard: **[{FRONTEND}]({FRONTEND})**" if FRONTEND else
                   "The 3D dashboard is deployed separately (Vercel)."))
    out = gr.Code(label="status", language="json")
    gr.Button("Refresh status").click(status, outputs=out)
    demo.load(status, outputs=out)

if __name__ == "__main__":
    # Plain Gradio launch — exactly what the ZeroGPU runtime expects (it wraps gr.Blocks.launch).
    demo.launch(ssr_mode=False, app_kwargs={"lifespan": outer_lifespan})
