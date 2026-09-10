---
description: 'Reference for every SOAT server environment variable, with guidance for production deployments.'
sidebar_label: Configuration
---

# Configuration

## Environment Variables

### Database

| Variable            | Default         | Description       |
| ------------------- | --------------- | ----------------- |
| `DATABASE_HOST`     | `localhost`     | PostgreSQL host   |
| `DATABASE_PORT`     | `5432`          | PostgreSQL port   |
| `DATABASE_NAME`     | `soat_dev`      | Database name     |
| `DATABASE_USER`     | `soat_user`     | Database user     |
| `DATABASE_PASSWORD` | `soat_password` | Database password |

The database needs [pgvector](https://github.com/pgvector/pgvector) **0.8 or newer** (the `pgvector/pgvector` image, or a manual install). Semantic search sets `hnsw.iterative_scan`, added in 0.8; an older extension discards the setting with a warning and a scoped or path-filtered search can silently come back short. See [Ranking is approximate](../modules/knowledge.md#ranking-is-approximate).

#### Standard `PG*` environment variables

Beyond `DATABASE_*` (most commonly TLS), the [`node-postgres`](https://node-postgres.com/features/connecting#environment-variables) driver honors the standard [libpq `PG*` environment variables](https://www.postgresql.org/docs/current/libpq-envars.html).

| Variable            | Description                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `PGSSLMODE`         | SSL negotiation mode: `disable`, `prefer`, `require`, `verify-ca`, `verify-full`, or `no-verify`   |
| `PGSSLROOTCERT`     | Path to a CA certificate bundle used to verify the server certificate (required for `verify-full`) |
| `PGCONNECT_TIMEOUT` | Connection timeout in seconds                                                                      |
| `PGOPTIONS`         | Command-line options to send to the server at connection time                                      |

Full list: [libpq environment variables](https://www.postgresql.org/docs/current/libpq-envars.html).

:::tip[Managed PostgreSQL with forced SSL]

**Amazon Aurora / RDS** may set `rds.force_ssl=1`. SOAT connects in plaintext by default, so the server exits at startup. Set `PGSSLMODE`:

```yaml
services:
  server:
    environment:
      # ... DATABASE_* variables
      PGSSLMODE: no-verify
```

`no-verify` encrypts without certificate verification. Stricter: `PGSSLMODE=verify-full` with `PGSSLROOTCERT` pointing at the provider's CA bundle (for RDS, the [Amazon RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)).

:::

:::note[Aurora PostgreSQL 18.3]

Aurora PostgreSQL 18.3 crashes on the ORM's multi-statement session-setup query (`SET client_min_messages ...; SET TIME ZONE ...`). SOAT suppresses the `SET TIME ZONE` half (the session timezone is UTC either way), so no extra configuration is needed.

:::

### Schema Sync

On boot, SOAT runs `sync({ alter: true })` behind a **session-level Postgres advisory lock**: concurrently starting tasks (rolling deploy, scale-out, instance refresh) serialize; one runs the schema changes, the rest see a no-op.

The wait is **bounded**: a task SIGKILLed mid-sync (grace-period expiry, OOM) can leave its backend and the lock lingering for minutes behind a pooler or a managed engine like Aurora. On timeout the boot fails fast (`canceling statement due to lock timeout`) with a non-zero exit, so the orchestrator restarts the task.

| Variable                      | Default          | Description                                                                                                     |
| ----------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `SCHEMA_SYNC_LOCK_TIMEOUT_MS` | `600000` (10min) | Upper bound in milliseconds on how long boot waits to acquire the schema-sync advisory lock before failing fast |

Any non-positive-integer value (non-numeric, `0`, negative, fractional, empty) falls back to the default.

:::warning
Keep this **larger than a legitimate migration's duration** and aligned with the health-check grace period. Lower it only when migrations are known to be fast.
:::

:::note[Indexes are never dropped by the sync]

`sync({ alter: true })` creates the indexes the current schema declares and never drops earlier ones. A renamed index leaves its predecessor in place; a widened unique index leaves the narrower one enforcing the old constraint, which can reject writes the current schema permits.

Release notes call out indexes to drop: `DROP INDEX CONCURRENTLY IF EXISTS <name>`, or `ALTER TABLE <table> DROP CONSTRAINT IF EXISTS <name>` when a UNIQUE constraint owns the index.

:::

### Server

| Variable                  | Default | Description                                                  |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `PORT`                    | `5047`  | HTTP port the server listens on                              |
| `SOAT_ERROR_LOGS_ENABLED` | `true`  | Controls request error logs from the global error middleware |

### Debug Logging

Logging uses the [`debug`](https://www.npmjs.com/package/debug) package.

| Variable | Default | Description                                                           |
| -------- | ------- | --------------------------------------------------------------------- |
| `DEBUG`  | _(off)_ | Enables debug namespaces (for example, `soat:*` or `soat:formations`) |

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

`SOAT_ERROR_LOGS_ENABLED` is independent of `DEBUG`. Unset means enabled; disable with `false`, `0`, `off`, or `no` (case-insensitive).

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

### Secrets Encryption

| Variable                 | Required | Description                                                       |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `SECRETS_ENCRYPTION_KEY` | **Yes**  | 64-character hex string (32 bytes) used to encrypt stored secrets |

Also encrypts [webhook](../modules/webhooks.md) and [trigger](../modules/triggers.md) signing secrets at rest. If lost, outbound webhook delivery and inbound webhook-trigger signature verification fail until each affected secret is rotated and subscribers receive the new value.

Generate a key:

```bash
openssl rand -hex 32
```

:::danger
`SECRETS_ENCRYPTION_KEY` must be set in production. Changing it makes stored secrets and webhook/trigger signing secrets unreadable.
:::

### Outbound Egress

| Variable                    | Default        | Description                                                                       |
| --------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `TOOL_EGRESS_ALLOWED_HOSTS` | _(unset)_      | Comma-separated non-public destinations the server may request on a tenant's behalf |

An [`http` or `mcp` tool](../modules/tools.md) target must be publicly routable
by default. Loopback, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local
(`169.254/16`, cloud metadata services), CGNAT and IPv6 ULA are refused with
`403 TOOL_EGRESS_BLOCKED` unless listed here. The same rule covers every
tenant-chosen destination:

| Destination                                                       | Refused how |
| ----------------------------------------------------------------- | ----------- |
| An `http`/`mcp` [tool](../modules/tools.md) target                 | `403 TOOL_EGRESS_BLOCKED` on the call |
| A [webhook](../modules/webhooks.md)'s `url`                        | the delivery is closed as `failed`, with the reason on the row |
| An [AI provider](../modules/ai-providers.md)'s `base_url`          | the generation or model listing fails |
| A GCP service-account key file's `token_uri`, on an `http` tool    | `403 TOOL_EGRESS_BLOCKED` on the call |

Operator-chosen destinations (`OLLAMA_BASE_URL`, `EMBEDDING_BASE_URL`, the
embedding stack) are not covered and keep working on localhost. Unset, the
public internet stays reachable; only non-public networks are closed.

```yaml
environment:
  # hostname, host:port, *.suffix, or CIDR — comma-separated
  TOOL_EGRESS_ALLOWED_HOSTS: 'billing.svc.cluster.local,*.internal.acme.com,10.42.0.0/16'
```

| Entry form                  | Matches                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `billing.svc.cluster.local` | that hostname, on any port, whatever it resolves to                  |
| `server:5047`               | that hostname, only on port 5047 (the URL's implicit scheme port counts) |
| `*.internal.acme.com`       | any subdomain of that suffix                                         |
| `10.42.0.0/16`              | any hostname whose **resolved** address falls in the range           |
| `[::1]:8080`                | an IPv6 literal with a port                                          |

A malformed entry fails loudly rather than being dropped. The **resolved**
address is checked (a public-looking hostname whose A record points at
`169.254.169.254` is refused), every redirect hop is checked, and credential
headers (`Authorization`, `Cookie`) are dropped when a redirect changes origin.

:::note
Deployment-wide, not per-project. When the destination is SOAT's own API, use a
[`builtin` tool](../modules/tools.md) rather than an `http` tool at your own
base URL: it dispatches in-process under the caller's permissions.
:::

### Provider Credentials

| Variable                                 | Default | Description                                                                                    |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS`  | `false` | Whether an AI provider record that links no credential may sign with the deployment's own       |

`bedrock` and `vertex` [AI provider](../modules/ai-providers.md) SDKs fall back
to the **deployment's** credentials: Bedrock walks the AWS default credential
chain (environment, instance or task role), Vertex resolves
[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials).
Unless this is `true`, a tenant-written provider record must carry its own
credential:

- `400 VALIDATION_FAILED` on create or update with neither a linked secret nor a
  `config.apiKey`;
- `400 AI_PROVIDER_MISCONFIGURED` when such a record generates or lists models,
  so one that reached the table another way fails closed.

Set `true` only on a **single-tenant** deployment (an EC2 instance profile or
ECS task role serving your own team); otherwise a tenant's record generates on
the deployment's cloud account, quotas and IAM role.

The embedding stack is unaffected: `EMBEDDING_PROVIDER` and its region are
operator settings, so `bedrock` embeddings always use the AWS credential chain.

### File Storage

| Variable            | Default       | Description                                     |
| ------------------- | ------------- | ----------------------------------------------- |
| `FILES_STORAGE_DIR` | `/data/files` | Local directory where uploaded files are stored |

Mount a persistent volume here in Docker.

### Agent Generation

| Variable                     | Default           | Description                                                                                     |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `SOAT_TOOL_CALL_TIMEOUT_MS`  | `300000`          | Maximum time in milliseconds to wait for a single external tool call (MCP, SOAT, or HTTP tools) |
| `TOOL_CONTEXT_HEADER_PREFIX` | `X-Soat-Context-` | Prefix prepended to every `tool_context` key to form the outbound request header name            |

A tool server that does not respond within `SOAT_TOOL_CALL_TIMEOUT_MS` (default 5 minutes) aborts the call and fails the generation.

`TOOL_CONTEXT_HEADER_PREFIX` renames the [context headers](../advanced/tool-context.md#configuring-the-header-prefix) a deployment emits (e.g. to hide the SOAT name from third-party tool providers). Prepended verbatim, so include the trailing `-` (`X-Acme-Context-` + `userId` → `X-Acme-Context-userId`). Must be a valid HTTP header-name prefix (letters, digits and ``!#$%&'*+-.^_`|~``); an invalid value fails the tool call with an error naming the variable. Empty or unset keeps the default; the prefix cannot be removed, since an unprefixed key could land on `Authorization`. Changing it breaks every tool endpoint already reading these headers: set it before wiring up tools, or update both sides together.

### Embeddings

[Ollama](https://ollama.com) by default; [OpenAI](https://platform.openai.com/docs/guides/embeddings) and [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html) are supported.

| Variable               | Default                  | Description                                                                                |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `EMBEDDING_PROVIDER`   | `ollama`                 | Embedding provider: `ollama`, `openai`, or `bedrock`                                       |
| `EMBEDDING_MODEL`      | `qwen3-embedding:0.6b`   | Model name for the selected provider                                                       |
| `EMBEDDING_DIMENSIONS` | `1024`                   | Embedding vector dimensions (must match the model; at most `2000`)                         |
| `OLLAMA_BASE_URL`      | `http://localhost:11434` | Base URL of the Ollama instance (`ollama` only)                                            |
| `EMBEDDING_API_KEY`    | —                        | OpenAI API key, or a Bedrock `ABSK…` bearer token. `openai` falls back to `OPENAI_API_KEY` |
| `EMBEDDING_BASE_URL`   | —                        | Override base URL for an OpenAI-compatible endpoint (`openai` only)                        |
| `EMBEDDING_REGION`     | `us-east-1`              | AWS region for Bedrock (`bedrock` only); falls back to `AWS_REGION`                        |
| `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD` | _(unset)_ | USD per **million** input tokens. Unset meters embeddings at `0`; the price book does not price them |

Embedding spend is priced from `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD`, not the price book (no AI provider record configures the embedding stack). Unset meters every embedding at `0` (correct for a local model, silently free on a vendor-billed one) and logs a startup warning. See [Pricing embeddings](/docs/modules/embeddings#pricing-embeddings).

Change `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` together. Dimensions may not exceed **2000**, the widest vector pgvector can build an HNSW index over; a larger model is refused at startup. Bedrock without `EMBEDDING_API_KEY` uses the AWS credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

## Docker Compose Example

PostgreSQL and Ollama run externally.

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
Replace every `change-me` and `SECRETS_ENCRYPTION_KEY` (`openssl rand -hex 32`) before deploying.
:::

## Linux: Connecting to Host Services from Docker

Docker on Linux does **not** resolve `host.docker.internal` automatically (Docker Desktop on macOS and Windows does). Reaching host services (Ollama, PostgreSQL) needs two steps.

### Step 1: Add `extra_hosts` to your Docker Compose file

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

Ollama binds to `127.0.0.1` by default, unreachable from a container:

```bash
# Create an override for the Ollama systemd service
sudo systemctl edit ollama
```

Add:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

Restart:

```bash
sudo systemctl restart ollama
```

:::warning
`OLLAMA_HOST=0.0.0.0` exposes Ollama on all interfaces; firewall port `11434` on a network-facing machine.
:::

### Verification

```bash
docker compose exec server wget -qO- http://host.docker.internal:11434/api/tags
```

Expected: a JSON list of Ollama models. Otherwise re-check both steps and `systemctl status ollama`.

## Production Checklist

- [ ] **Generate a strong `SECRETS_ENCRYPTION_KEY`** — `openssl rand -hex 32`
- [ ] **Use strong database credentials** — change the defaults
- [ ] **Set `SOAT_ADMIN_USERNAME` / `SOAT_ADMIN_PASSWORD`** — or call `/bootstrap` immediately after first deploy
- [ ] **Mount a persistent volume** on `FILES_STORAGE_DIR` to preserve uploaded files
- [ ] **Back up the PostgreSQL volume** regularly — all data lives in Postgres and on the file storage
- [ ] **Put SOAT behind a reverse proxy** (nginx, Caddy, etc.) with TLS termination — the server does not handle HTTPS directly
