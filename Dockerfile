FROM node:22.22.2-bookworm-slim AS build
WORKDIR /src
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.22.2-bookworm-slim
USER root
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SESSION_DATA_PATH=/data/sessions \
    OUTBOX_PATH=/data/outbox \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates dumb-init fonts-liberation fonts-noto-color-emoji zstd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
RUN mkdir -p /data/sessions /data/outbox && chown -R node:node /app /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
