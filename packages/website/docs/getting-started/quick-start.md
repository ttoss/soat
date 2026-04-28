---
sidebar_position: 1
slug: /getting-started
---

# Quick Start

Get SOAT running locally with Docker Compose in under five minutes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2+
- [curl](https://curl.se/) and [jq](https://jqlang.github.io/jq/) (for the API examples below)

## 1. Create a Docker Compose file

Create a new directory and save the following as `docker-compose.yml`:

```yaml
services:
  database:
    image: pgvector/pgvector:0.8.2-pg18-trixie
    environment:
      POSTGRES_DB: soat
      POSTGRES_USER: soat_user
      POSTGRES_PASSWORD: soat_password
    volumes:
      - postgres_data:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U soat_user -d soat']
      interval: 10s
      timeout: 5s
      retries: 5

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama_cache:/root/.ollama
    entrypoint:
      - /bin/sh
      - -c
      - 'ollama serve > /dev/null 2>&1 & sleep 5 && ollama pull qwen3-embedding:0.6b > /dev/null 2>&1 && ollama pull qwen2.5:0.5b > /dev/null 2>&1 && wait'
    healthcheck:
      test: ['CMD-SHELL', 'ollama list | grep qwen3-embedding']
      interval: 10s
      timeout: 30s
      retries: 30
      start_period: 30s

  server:
    image: ttoss/soat
    depends_on:
      database:
        condition: service_healthy
      ollama:
        condition: service_healthy
    ports:
      - '5047:5047'
    environment:
      SOAT_ADMIN_USERNAME: admin
      SOAT_ADMIN_PASSWORD: Admin1234!
      DATABASE_HOST: database
      DATABASE_PORT: '5432'
      DATABASE_NAME: soat
      DATABASE_USER: soat_user
      DATABASE_PASSWORD: soat_password
      SECRETS_ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      FILES_STORAGE_DIR: /data/files
      OLLAMA_BASE_URL: http://ollama:11434
      EMBEDDING_PROVIDER: ollama
      EMBEDDING_MODEL: qwen3-embedding:0.6b
      EMBEDDING_DIMENSIONS: '1024'
    volumes:
      - files_data:/data/files

volumes:
  postgres_data:
  ollama_cache:
  files_data:
```

:::warning
Change the secrets before going to production

Replace `SOAT_ADMIN_PASSWORD` and `SECRETS_ENCRYPTION_KEY` with strong values before exposing SOAT outside of localhost. See [Advanced Configuration](/docs/getting-started/advanced-config) for details.
:::

## 2. Start the stack

```bash
docker compose up -d
```

This starts three services:

| Service    | Description                                                          |
| ---------- | -------------------------------------------------------------------- |
| `database` | PostgreSQL 18 with pgvector for relational and vector storage        |
| `ollama`   | Local LLM runtime (downloads `qwen3-embedding` and `qwen2.5` models) |
| `server`   | SOAT REST API + MCP server, exposed on port **5047**                 |

The first run pulls Docker images and downloads the Ollama models, which may take a few minutes. Wait until all services are healthy:

```bash
docker compose ps
```

All three services should show `healthy` or `running`.

## 3. Log in and obtain a token

```bash
TOKEN=$(curl -s -X POST http://localhost:5047/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

echo "Token: ${TOKEN:0:40}..."
```

All subsequent requests use this JWT in the `Authorization` header.

## 4. Create your first project

Projects are the primary resource boundary in SOAT. Every document, file, secret, and agent belongs to a project.

```bash
PROJECT=$(curl -s -X POST http://localhost:5047/api/v1/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"my-first-project"}' | jq)

echo "$PROJECT" | jq .

PROJECT_ID=$(echo "$PROJECT" | jq -r '.id')
```

## 5. Send your first chat message

First, register Ollama as an AI provider for the project:

```bash
AI_PROVIDER_ID=$(curl -s -X POST http://localhost:5047/api/v1/ai-providers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"Local Ollama\",
    \"provider\": \"ollama\",
    \"base_url\": \"http://ollama:11434\",
    \"default_model\": \"qwen2.5:0.5b\"
  }" | jq -r '.id')

echo "AI Provider: $AI_PROVIDER_ID"
```

Then send a stateless completion — no chat resource required:

```bash
curl -s -X POST http://localhost:5047/api/v1/chats/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"ai_provider_id\": \"$AI_PROVIDER_ID\",
    \"messages\": [
      { \"role\": \"system\", \"content\": \"You are a helpful assistant.\" },
      { \"role\": \"user\", \"content\": \"What is the color of the sky?\" }
    ]
  }" | jq '.choices[0].message.content'
```

You should see a short answer from `qwen2.5:0.5b` running locally via Ollama.

## 6. What's next?

If you continue with the CLI docs and tutorials, path parameters use resource-specific kebab-case flags such as `--project-id`, `--agent-id`, and `--session-id` rather than a generic `--id`.

| Goal                                           | Where to go                                                     |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Understand the permission model                | [IAM module](/docs/modules/iam)                                 |
| Browse the current CLI command surface         | [CLI Commands Reference](/docs/cli/commands)                    |
| Connect an LLM provider (OpenAI, Anthropic, …) | [AI Providers module](/docs/modules/ai-providers)               |
| Save a reusable chat configuration             | [Chats module](/docs/modules/chats)                             |
| Define and run an agent                        | [Agents module](/docs/modules/agents)                           |
| Interact via MCP                               | [MCP docs](/docs/mcp)                                           |
| Use the TypeScript SDK                         | [SDK docs](/docs/sdk)                                           |
| Full REST reference                            | [API Reference](/docs/api)                                      |
| Tune environment variables                     | [Advanced Configuration](/docs/getting-started/advanced-config) |
