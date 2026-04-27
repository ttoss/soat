FROM node:24-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/postgresdb/package.json ./packages/postgresdb/

# Use hoisted node_modules layout so devDep binaries (e.g. tsup) are resolvable
RUN echo "node-linker=hoisted" > .npmrc
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/cli ./packages/cli
COPY packages/sdk ./packages/sdk
COPY packages/server ./packages/server
COPY packages/postgresdb ./packages/postgresdb

# Build postgresdb first (server depends on it)
RUN pnpm --filter @soat/postgresdb build

# Build SDK and CLI for smoke tests
RUN pnpm --filter @soat/sdk build
RUN pnpm --filter @soat/cli build

# Build server
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
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/postgresdb/dist ./packages/postgresdb/dist

# Mark dist/esm as ESM so Node.js parses import statements correctly
RUN echo '{"type":"module"}' > packages/server/dist/esm/package.json

# Directory where uploaded files are persisted
ENV FILES_STORAGE_DIR=/data/files

# Create the default storage directory
RUN mkdir -p /data/files

VOLUME ["/data/files"]

EXPOSE 5047

CMD ["node", "packages/server/dist/esm/server.js"]
