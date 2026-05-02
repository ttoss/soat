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

| Variable                  | Default | Description                                                                |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `PORT`                    | `5047`  | HTTP port the server listens on                                            |
| `SOAT_ERROR_LOGS_ENABLED` | `true`  | Enables request error logs from the global error middleware (`true/false`) |

Set `SOAT_ERROR_LOGS_ENABLED=false` if you want to suppress request error logs (for example, when log collection is handled externally).

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

### Embeddings

SOAT uses [Ollama](https://ollama.com) by default for generating vector embeddings.

| Variable               | Default                  | Description                                              |
| ---------------------- | ------------------------ | -------------------------------------------------------- |
| `EMBEDDING_PROVIDER`   | `ollama`                 | Embedding provider. Currently only `ollama` is supported |
| `EMBEDDING_MODEL`      | `qwen3-embedding:0.6b`   | Ollama model name for embeddings                         |
| `EMBEDDING_DIMENSIONS` | `1024`                   | Embedding vector dimensions (must match the model)       |
| `OLLAMA_BASE_URL`      | `http://localhost:11434` | Base URL of the Ollama instance                          |

To use a different embedding model, update all three `EMBEDDING_*` variables together — the model name and dimension count must be consistent.

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

## Linux: Connecting to a Host-Machine Ollama

On **Docker Desktop** (macOS and Windows), `host.docker.internal` resolves automatically to the host machine. On **Linux**, this hostname is not available by default, so containers cannot reach services bound to `127.0.0.1` on the host.

If you run Ollama on the Linux host and reference it as `http://host.docker.internal:11434` inside a container, you will get errors similar to:

```
AI_RetryError: Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND host.docker.internal
```

Two steps are required to fix this:

### Step 1 — Add `extra_hosts` to Docker Compose

In your `docker-compose.yml`, add `extra_hosts` to the `server` service so the container can resolve `host.docker.internal`:

```yaml
services:
  server:
    image: ttoss/soat:latest
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    environment:
      OLLAMA_BASE_URL: http://host.docker.internal:11434
      # ... other variables
```

### Step 2 — Bind Ollama to all interfaces

By default, Ollama binds to `127.0.0.1`, which is unreachable from inside a Docker container even with `host-gateway`. Configure Ollama to listen on all interfaces:

```bash
sudo systemctl edit ollama
```

Add the following, then save and close:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

Restart Ollama:

```bash
sudo systemctl restart ollama
```

Verify it is listening on all interfaces:

```bash
ss -tlnp | grep 11434
# Should show 0.0.0.0:11434
```

Both steps are required. `extra_hosts` maps the hostname, and `OLLAMA_HOST=0.0.0.0` makes the Ollama process reachable at that address from within the container network.

## Production Checklist

Before deploying SOAT in production:

- [ ] **Generate a strong `SECRETS_ENCRYPTION_KEY`** — `openssl rand -hex 32`
- [ ] **Use strong database credentials** — change the defaults
- [ ] **Set `SOAT_ADMIN_USERNAME` / `SOAT_ADMIN_PASSWORD`** — or call `/bootstrap` immediately after first deploy
- [ ] **Mount a persistent volume** on `FILES_STORAGE_DIR` to preserve uploaded files
- [ ] **Back up the PostgreSQL volume** regularly — all data lives in Postgres and on the file storage
- [ ] **Put SOAT behind a reverse proxy** (nginx, Caddy, etc.) with TLS termination — the server does not handle HTTPS directly
