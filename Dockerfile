FROM node:22-slim AS base
# better-sqlite3 compiles from source when no prebuild matches this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
# ffmpeg does the cutting, the 9:16 reframe and the caption burn-in; libass
# comes with Debian's build. yt-dlp and faster-whisper are Python, and Debian
# refuses `pip install` into the system interpreter (PEP 668), so they get a
# venv rather than --break-system-packages.
#
# fonts-dejavu-core is only a fallback: the caption fonts ship in assets/fonts
# and are handed to libass explicitly. It is here so a Japanese or Cyrillic
# subtitle renders glyphs instead of boxes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv fonts-dejavu-core ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
         "yt-dlp>=2025.1.1" "faster-whisper>=1.1.0" \
    && apt-get purge -y --auto-remove \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV IN_DOCKER=1
ENV PORT=4325
ENV HOSTNAME=0.0.0.0
ENV DB_PATH=/app/data/fableclip.db
ENV MEDIA_DIR=/app/data/media
# Keeps the Whisper weights on the mounted volume, so the ~145 MB download
# happens once rather than on every `docker compose up`.
ENV HF_HOME=/app/data/models

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/assets ./assets

RUN mkdir -p /app/data/media /app/data/models
EXPOSE 4325
CMD ["node", "server.js"]
