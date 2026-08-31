FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

WORKDIR /app
RUN npm install --global npm@12.0.2
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node viewer-server.js youtube-client.js ./
COPY --chown=node:node scripts/media-preflight.js ./scripts/
COPY --chown=node:node public ./public
COPY --chown=node:node views/header.ejs views/index.ejs views/search.ejs views/watch.ejs ./views/
RUN mkdir /data && chown node:node /data

USER node
ENV NODE_ENV=production \
    PORT=3000 \
    APP_DATA_DIR=/data \
    MAX_VIDEO_SECONDS=900 \
    MAX_OUTPUT_BYTES=314572800 \
    MAX_CACHE_BYTES=21474836480 \
    YOUTUBE_API_TIMEOUT_MS=15000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "viewer-server.js"]
