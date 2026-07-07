---
sidebar_position: 3
---

# Advanced Configuration

This page covers all environment variables available for the SOAT server, along with guidance for production deployments.

## Environment Variables

### Database

| Variable            | Default         | Description       |
| ------------------- | --------------- | ----------------- |
| `DATABASE_HOST`     | `localhost`     | PostgreSQL host   |
| `DATABASE_PORT`     | `5432`          | PostgreSQL port   |
| `DATABASE_NAME`     | `soat_dev`      | Database name     |
| `DATABASE_USER`     | `soat_user`     | Database user     |
| `DATABASE_PASSWORD` | `soat_password` | Database password |

The database must have the [pgvector](https://github.com/pgvector/pgvector) extension installed. Use the official `pgvector/pgvector` Docker image or install the extension manually.

### Server

| Variable                  | Default | Description                                                  |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `PORT`                    | `5047`  | HTTP port the server listens on                              |
| `SOAT_ERROR_LOGS_ENABLED` | `true`  | Controls request error logs from the global error middleware |

### Debug Logging

SOAT uses the [`debug`](https://www.npmjs.com/package/debug) package internally. Enable debug logs with the standard `DEBUG` environment variable.

| Variable | Default | Description                                                           |
| -------- | ------- | --------------------------------------------------------------------- |
| `DEBUG`  | _(off)_ | Enables debug namespaces (for example, `soat:*` or `soat:formations`) |

Examples:

```bash
# Enable all SOAT debug namespaces
DEBUG=soat:* pnpm dev

# Enable only formation-related logs
DEBUG=soat:formations pnpm dev
```

In Docker Compose:

```yaml
services:
  server:
    environment:
      DEBUG: soat:*
```

`SOAT_ERROR_LOGS_ENABLED` is independent from `DEBUG` namespaces.
When unset, request error logs are enabled by default.
To disable them, set the value to one of: `false`, `0`, `off`, or `no` (case-insensitive).

Valid examples:

```bash
# Disable request error logs from the global middleware
SOAT_ERROR_LOGS_ENABLED=false pnpm dev

# Also disables (same behavior, case-insensitive)
SOAT_ERROR_LOGS_ENABLED=OFF pnpm dev

# Request error logs still remain enabled regardless of DEBUG filters
SOAT_ERROR_LOGS_ENABLED=true DEBUG=soat:formations pnpm dev
```

### Admin Bootstrap

| Variable              | Required | Description                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------------- |
| `SOAT_ADMIN_USERNAME` | No       | If set and no users exist at startup, an admin account is created automatically |
| `SOAT_ADMIN_PASSWORD` | No       | Password for the auto-created admin. Must meet complexity requirements          |

This is useful for container-based deployments where you want the first admin seeded without a manual API call.

### Secrets Encryption

| Variable                 | Required | Description                                                       |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `SECRETS_ENCRYPTION_KEY` | **Yes**  | 64-character hex string (32 bytes) used to encrypt stored secrets |

Generate a secure key:

```bash
openssl rand -hex 32
```

:::danger
Production requirement

`SECRETS_ENCRYPTION_KEY` must be set in production. Changing it after secrets have been stored will make those secrets unreadable.
:::

### File Storage

| Variable            | Default       | Description                                     |
| ------------------- | ------------- | ----------------------------------------------- |
| `FILES_STORAGE_DIR` | `/data/files` | Local directory where uploaded files are stored |

Mount a persistent volume to this path in Docker to prevent data loss between container restarts.

### Agent Generation

| Variable                    | Default  | Description                                                                                     |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `SOAT_TOOL_CALL_TIMEOUT_MS` | `300000` | Maximum time in milliseconds to wait for a single external tool call (MCP, SOAT, or HTTP tools) |

If an external tool server does not respond within this window, the call is aborted and the generation fails with an error. The default is 5 minutes. Set a lower value to fail fast in latency-sensitive environments.

### Embeddings

SOAT uses [Ollama](https://ollama.com) by default for generating vector embeddings, and also supports [OpenAI](https://platform.openai.com/docs/guides/embeddings) and [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html).

| Variable               | Default                  | Description                                                                                    |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `EMBEDDING_PROVIDER`   | `ollama`                 | Embedding provider: `ollama`, `openai`, or `bedrock`                                           |
| `EMBEDDING_MODEL`      | `qwen3-embedding:0.6b`   | Model name for the selected provider                                                           |
| `EMBEDDING_DIMENSIONS` | `1024`                   | Embedding vector dimensions (must match the model)                                             |
| `OLLAMA_BASE_URL`      | `http://localhost:11434` | Base URL of the Ollama instance (`ollama` only)                                                |
| `EMBEDDING_API_KEY`    | —                        | OpenAI API key, or a Bedrock `ABSK…` bearer token. `openai` falls back to `OPENAI_API_KEY`     |
| `EMBEDDING_BASE_URL`   | —                        | Override base URL for an OpenAI-compatible endpoint (`openai` only)                            |
| `EMBEDDING_REGION`     | `us-east-1`              | AWS region for Bedrock (`bedrock` only); falls back to `AWS_REGION`                             |

To use a different embedding model, update `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` together — the model name and dimension count must be consistent. For `openai` and `bedrock`, set the provider's credentials as well; Bedrock without `EMBEDDING_API_KEY` uses the standard AWS credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

## Docker Compose Example

The following `docker-compose.yml` deploys the SOAT server, assuming PostgreSQL and Ollama are already running externally.

```yaml
services:
  server:
    image: ttoss/soat:latest
    ports:
      - '5047:5047'
    environment:
      SOAT_ADMIN_USERNAME: admin
      SOAT_ADMIN_PASSWORD: change-me
      SOAT_ERROR_LOGS_ENABLED: 'true'
      DATABASE_HOST: <postgres-host>
      DATABASE_PORT: '5432'
      DATABASE_NAME: soat_prod
      DATABASE_USER: soat_user
      DATABASE_PASSWORD: change-me
      SECRETS_ENCRYPTION_KEY: <64-char hex — run `openssl rand -hex 32`>
      FILES_STORAGE_DIR: /data/files
      OLLAMA_BASE_URL: http://<ollama-host>:11434
      EMBEDDING_PROVIDER: ollama
      EMBEDDING_MODEL: qwen3-embedding:0.6b
      EMBEDDING_DIMENSIONS: '1024'
    volumes:
      - files_data:/data/files

volumes:
  files_data:
```

:::tip
Replace every `change-me` placeholder and the `SECRETS_ENCRYPTION_KEY` before deploying. Use `openssl rand -hex 32` to generate a secure key.
:::

## Linux: Connecting to Host Services from Docker

When running SOAT inside Docker on Linux and connecting to services on the host machine (such as Ollama or PostgreSQL), you need additional configuration. Unlike Docker Desktop on macOS and Windows, Docker on Linux does **not** automatically resolve `host.docker.internal`.

### Step 1: Add `extra_hosts` to your Docker Compose file

Add the following to the SOAT server service so that `host.docker.internal` resolves to the host machine's gateway IP:

```yaml
services:
  server:
    image: ttoss/soat:latest
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    environment:
      OLLAMA_BASE_URL: http://host.docker.internal:11434
      # ... other environment variables
```

### Step 2: Configure Ollama to listen on all interfaces

By default, Ollama binds only to `127.0.0.1`, which is unreachable from inside a Docker container even after resolving `host.docker.internal`. You must configure Ollama to listen on all interfaces:

```bash
# Create an override for the Ollama systemd service
sudo systemctl edit ollama
```

In the editor that opens, add:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

Then restart Ollama:

```bash
sudo systemctl restart ollama
```

:::warning
Setting `OLLAMA_HOST=0.0.0.0` makes Ollama accessible on all network interfaces. Ensure your firewall restricts port `11434` to trusted sources if this machine is network-facing.
:::

### Verification

After completing both steps, verify that SOAT can reach Ollama from within the container:

```bash
docker compose exec server wget -qO- http://host.docker.internal:11434/api/tags
```

You should see a JSON response listing available Ollama models. If you see a connection error, check that both steps above were completed and that `ollama` is running (`systemctl status ollama`).

## Production Checklist

Before deploying SOAT in production:

- [ ] **Generate a strong `SECRETS_ENCRYPTION_KEY`** — `openssl rand -hex 32`
- [ ] **Use strong database credentials** — change the defaults
- [ ] **Set `SOAT_ADMIN_USERNAME` / `SOAT_ADMIN_PASSWORD`** — or call `/bootstrap` immediately after first deploy
- [ ] **Mount a persistent volume** on `FILES_STORAGE_DIR` to preserve uploaded files
- [ ] **Back up the PostgreSQL volume** regularly — all data lives in Postgres and on the file storage
- [ ] **Put SOAT behind a reverse proxy** (nginx, Caddy, etc.) with TLS termination — the server does not handle HTTPS directly
