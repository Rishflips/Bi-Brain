FROM node:24.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --cache /tmp/npm-cache
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY tsconfig.json ./
RUN npm run build
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV NODE_ENV=production BRAIN_DB=/app/data/brain.sqlite BRAIN_CONTAINER=1
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4317/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/run.mjs", "production"]
