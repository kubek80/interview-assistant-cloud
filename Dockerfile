# syntax=docker/dockerfile:1.7
# One image serves the browser app and the API (HOST-2). The same image runs the release job
# (migrations and, once, the seed): override the arguments with `dist/server/cli.js migrate`.
#
# Status: not built in the environment this was written in (no Docker there). The build and start
# commands below were run outside Docker with the same files; see docs/deploy/README.md "Status".

ARG NODE_VERSION=22.23.5

# ---- 1. Build: install everything, typecheck, build the browser app and the server bundle ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# .npmrc sets ignore-scripts: no dependency runs install scripts.
RUN npm ci
COPY tsconfig.json vite.config.ts vite.server.config.ts index.html ./
COPY public ./public
COPY schema ./schema
COPY docs ./docs
COPY src ./src
COPY server ./server
COPY e2e ./e2e
COPY playwright.config.ts vitest.server.config.ts ./
RUN npm run build

# ---- 2. Production dependencies only (the server's; the browser's are bundled into dist/client) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 3. Runtime: distroless Node.js, no shell or package manager, runs as a non-root user ----
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=dist/client \
    MIGRATIONS_DIR=server/db/migrations \
    SEED_DIR=seed
COPY --from=deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --chown=nonroot:nonroot package.json ./
COPY --chown=nonroot:nonroot server/db/migrations ./server/db/migrations
COPY --chown=nonroot:nonroot seed ./seed
USER nonroot
EXPOSE 8080
# The distroless entrypoint is node itself.
CMD ["dist/server/main.js"]
