FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node viewer-server.js ./
COPY --chown=node:node public ./public

USER node
ENV NODE_ENV=production \
    PORT=3000 \
    APP_DATA_DIR=/data \
    MAX_VIDEO_SECONDS=900 \
    MAX_OUTPUT_BYTES=314572800
EXPOSE 3000
CMD ["node", "viewer-server.js"]
