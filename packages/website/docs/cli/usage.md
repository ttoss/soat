---
description: "Common SOAT CLI workflows and command examples for agents, sessions, projects, and more."
sidebar_position: 2
---

# Usage Examples

All examples assume a configured profile ([setup](./introduction.md)).

## Configure a Profile

```bash
soat configure
# Base URL: http://localhost:5047
# Token (hidden): <your-jwt-or-sdk-key>
```

Multiple environments:

```bash
soat configure --profile prod
# Base URL: https://api.example.com
# Token (hidden): sk_...

soat --profile prod list-actors --project-id proj_01
```

## List All Commands

```bash
soat list-commands
```

## Users

```bash
soat bootstrap-user --username admin --password supersecret
soat login-user --username admin --password supersecret
```

## Projects

```bash
# Create a project
soat create-project --name "My Project"

# List all projects
soat list-projects

# Get a specific project
soat get-project --project-id proj_01
```

## Actors

```bash
# List actors for a project
soat list-actors --project-id proj_01

# Create an actor
soat create-actor --name "Support Bot" --project-id proj_01

# Get a specific actor
soat get-actor --actor-id actor_01

# Delete an actor
soat delete-actor --actor-id actor_01
```

## Files

```bash
# List files in a project
soat list-files --project-id proj_01

# Get a specific file
soat get-file --file-id file_01

# Delete a file
soat delete-file --file-id file_01
```

## Testing Webhooks Locally

`soat listen` receives outbound [Webhook](../modules/webhooks.md) deliveries and inbound [Trigger](../modules/triggers.md) `X-Soat-Signature` payloads on a local HTTP server:

```bash
soat listen --port 8787 --path /webhook --secret "$WEBHOOK_SECRET"
# Listening for SOAT webhooks on http://localhost:8787/webhook
```

Point a webhook's `url` (or a `webhook`-type trigger's target, via a tunnel such as `ngrok`) at this address.

- `--port` — port to listen on (default `8787`)
- `--path` — request path to accept (default `/webhook`)
- `--secret` — verify `X-Soat-Signature` against this webhook/trigger secret; mismatch is rejected with `401`
- `--filter` — only print events matching a pattern, e.g. `sessions.generation.*,files.*` (comma-separated, trailing `*` wildcard)
- `--json` — print one JSON object per line instead of a human-readable block

Each accepted delivery prints `event_type`, `delivery_id`, signature validity (with `--secret`), then the pretty-printed payload.

## Passing Body Fields

REST field names in kebab-case; path parameters keep resource-specific names:

```bash
soat create-actor --name "My Bot" --project-id proj_01
soat update-actor --actor-id actor_01 --name "Renamed Bot"
```

## JSON Output

Every command prints the API response as JSON:

```bash
soat get-actor --actor-id actor_01
# {
#   "id": "actor_01",
#   "name": "Support Bot",
#   "type": "ai",
#   ...
# }
```

Pipe to `jq`:

```bash
soat list-actors --project-id proj_01 | jq '.[].name'
```
