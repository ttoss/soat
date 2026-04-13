FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/postgresdb/package.json ./packages/postgresdb/
COPY packages/cli/package.json ./packages/cli/

# Use hoisted node_modules layout so devDep binaries (e.g. tsup) are resolvable
RUN echo "node-linker=hoisted" > .npmrc
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/server ./packages/server
COPY packages/postgresdb ./packages/postgresdb

# Build postgresdb first (server depends on it)
RUN pnpm --filter @soat/postgresdb build

# Build server
RUN pnpm --filter @soat/server build

# ---- Production image ----
FROM node:24-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/postgresdb/package.json ./packages/postgresdb/
COPY packages/cli/package.json ./packages/cli/

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
