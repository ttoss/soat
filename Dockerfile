FROM node:24-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/app/package.json ./packages/app/
COPY packages/cli/package.json ./packages/cli/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/postgresdb/package.json ./packages/postgresdb/

# Use hoisted node_modules layout so devDep binaries (e.g. tsup) are resolvable
RUN echo "node-linker=hoisted" > .npmrc
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/app ./packages/app
COPY packages/cli ./packages/cli
COPY packages/sdk ./packages/sdk
COPY packages/server ./packages/server
COPY packages/postgresdb ./packages/postgresdb

# Build postgresdb first (server depends on it)
RUN pnpm --filter @soat/postgresdb build

# Build SDK and CLI for smoke tests
RUN pnpm --filter @soat/sdk build
RUN pnpm --filter @soat/cli build

# Build app and server
RUN pnpm --filter @soat/app build
RUN pnpm --filter @soat/server build

# ---- Smoke-test image ----
FROM node:24-slim AS smoke-test

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl jq \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Copy workspace manifests and lock file
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/sdk/package.json ./packages/sdk/

# Install only CLI production dependencies (hoisted)
RUN echo "node-linker=hoisted" > .npmrc \
	&& pnpm install --frozen-lockfile --filter @soat/cli --prod --ignore-scripts

# Copy built dist from builder stage
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist/
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist/

# Copy the CLI bin wrapper and make it globally accessible
COPY packages/cli/bin ./packages/cli/bin/
RUN chmod +x ./packages/cli/bin/soat \
    && ln -s /app/packages/cli/bin/soat /usr/local/bin/soat

COPY tests/smoke-tests.sh /smoke-tests.sh

CMD ["sh", "/smoke-tests.sh"]

# ---- Production image ----
FROM node:24-slim AS production

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/postgresdb/package.json ./packages/postgresdb/

# Install production dependencies only (skip lifecycle scripts like husky)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/packages/app/dist ./packages/app/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/postgresdb/dist ./packages/postgresdb/dist

# Directory where uploaded files are persisted
ENV FILES_STORAGE_DIR=/data/files

# responseContract (packages/server/src/middleware/responseContract.ts) only
# pays its per-request path-match + key-walk cost outside production; without
# this, the default deployment never gets that "production never pays the
# cost" guarantee.
ENV NODE_ENV=production

# Create the default storage directory, owned by the unprivileged user the
# server runs as.
RUN mkdir -p /data/files && chown -R node:node /data/files

VOLUME ["/data/files"]

# The server needs no root capability at runtime: it binds 5047 (above 1024)
# and writes only under /data/files. Root buys nothing here and hands a
# container-escape or a path-handling bug the whole filesystem, so drop it.
# A bind-mounted host volume must be writable by uid 1000 (node); an existing
# deployment mounting a root-owned directory needs `chown 1000:1000` on it once.
USER node

EXPOSE 5047

CMD ["node", "--enable-source-maps", "packages/server/dist/server.mjs"]
