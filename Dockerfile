FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN npm install --global npm@12.0.2
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node viewer-server.js ./
COPY --chown=node:node public ./public

USER node
ENV NODE_ENV=production \
    PORT=3000 \
    APP_DATA_DIR=/data \
    MAX_VIDEO_SECONDS=900 \
    MAX_OUTPUT_BYTES=314572800
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "viewer-server.js"]
