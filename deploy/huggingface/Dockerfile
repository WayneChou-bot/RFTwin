# Hugging Face Space (Docker) — backend only; the frontend lives on Vercel and points here via VITE_API_BASE.
# Build pulls the public GitHub repo, so this Space repo holds just README.md + this file.
FROM python:3.11-slim

ARG RFTWIN_REF=main
ARG CACHE_BUST=2026-09-12      # change this value to force a rebuild against the latest commit

RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone --depth 1 --branch "${RFTWIN_REF}" https://github.com/WayneChou-bot/RFTwin.git /tmp/src \
 && cp -r /tmp/src/apps /tmp/src/packages /tmp/src/config /tmp/src/schemas /tmp/src/assets /tmp/src/requirements.txt /app/ \
 && rm -rf /tmp/src
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/packages:/app \
    TWIN_RATE_LIMIT=1 TWIN_HEALTH_STALL_S=10 TWIN_XFF=first

# Spaces run the container as uid 1000
RUN useradd -m -u 1000 user && chown -R user:user /app
USER user
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "apps.factory_backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "wsproto"]
