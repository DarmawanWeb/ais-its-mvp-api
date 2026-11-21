# syntax=docker/dockerfile:1

# Legacy MVP API (Express + Mongoose). Build: docker build -t seemp-legacy-be .
# Run:   docker run --env-file .env -p 3020:3020 seemp-legacy-be

FROM node:22-alpine AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from "packageManager" in package.json.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY bin ./bin
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3020
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The EWS geometry is read from data/ relative to the working directory.
COPY --chown=node:node package.json ./
COPY --chown=node:node data ./data
USER node
# 3020: HTTP API. 3004: ingest socket.io server (WEBSOCKET_SERVER_PORT).
EXPOSE 3020 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "dist/bin/www.js"]
