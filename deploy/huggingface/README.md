---
title: RFTwin Backend
emoji: 🏭
colorFrom: blue
colorTo: gray
sdk: gradio
sdk_version: 6.27.0
python_version: "3.12"
app_file: app.py
pinned: false
license: mit
short_description: Simulation backend (FastAPI + WebSocket) for RFTwin
---

# Robot Factory Digital Twin — backend

Authoritative simulation engine + REST/WebSocket API for
[RFTwin](https://github.com/WayneChou-bot/RFTwin). The 3D frontend is served separately (Vercel);
this Space exposes `/api/*`, `/ws`, `/api/health` and a small status page at `/`.

`app.py` downloads the GitHub repository (`RFTWIN_REF`, default `main`) when the Space starts, so this
Space repo holds only `README.md`, `app.py` and `requirements.txt`. To pick up a new commit:
*Settings → Restart Space* (or *Factory rebuild*).

Space variables: `TWIN_CORS_ORIGINS=https://<your-frontend>.vercel.app` (required — the backend accepts
cross-site requests only from listed origins), optional `RFTWIN_FRONTEND_URL` (link shown on the status page).
