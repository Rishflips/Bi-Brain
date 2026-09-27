FROM node:24.19.0-bookworm-slim
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
CMD ["node", "scripts/run.mjs", "production"]
