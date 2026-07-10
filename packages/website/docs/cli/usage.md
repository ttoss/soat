---
sidebar_position: 2
---

# Usage Examples

Common workflows using the SOAT CLI. All examples assume a configured profile — see [introduction](./introduction.md) for setup.

## Configure a Profile

```bash
soat configure
# Base URL: http://localhost:5047
# Token (hidden): <your-jwt-or-sdk-key>
```

Use `--profile` to work with multiple environments:

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

Bootstrap the first admin user, then log in to obtain a session token:

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

`soat listen` starts a local HTTP server that receives webhook deliveries — both outbound [Webhook](../modules/webhooks.md) deliveries and inbound [Trigger](../modules/triggers.md) `X-Soat-Signature` payloads — so you can inspect them before wiring up a real endpoint:

```bash
soat listen --port 8787 --path /webhook --secret "$WEBHOOK_SECRET"
# Listening for SOAT webhooks on http://localhost:8787/webhook
```

Point a webhook's `url` (or a `webhook`-type trigger's target, via a tunnel such as `ngrok`) at this address during development. Options:

- `--port` — port to listen on (default `8787`)
- `--path` — request path to accept (default `/webhook`)
- `--secret` — verify `X-Soat-Signature` against this webhook/trigger secret; the request is rejected with `401` on a signature mismatch
- `--filter` — only print events matching a pattern, e.g. `sessions.generation.*,files.*` (comma-separated, trailing `*` wildcard)
- `--json` — print one JSON object per line instead of a human-readable block

Each accepted delivery prints its `event_type`, `delivery_id`, and (when `--secret` is set) whether the signature was valid, followed by the pretty-printed payload.

## Passing Body Fields

All request body fields are passed as `--flag value` arguments. Field names follow the REST API contract but are exposed in kebab-case, and path parameters keep their resource-specific names:

```bash
soat create-actor --name "My Bot" --project-id proj_01
soat update-actor --actor-id actor_01 --name "Renamed Bot"
```

## Passing a Single Resource ID

For a command with exactly one path parameter, you can skip the resource-specific flag and pass the ID as a bare positional argument, or via the generic `--id` flag:

```bash
soat get-actor actor_01
soat get-actor --id actor_01
# equivalent to:
soat get-actor --actor-id actor_01
```

If the required ID is omitted entirely, the CLI fails fast with a clear error instead of sending an incomplete request.

## JSON Output

Every command prints the API response as formatted JSON:

```bash
soat get-actor --actor-id actor_01
# {
#   "id": "actor_01",
#   "name": "Support Bot",
#   "type": "ai",
#   ...
# }
```

Pipe to `jq` for filtering:

```bash
soat list-actors --project-id proj_01 | jq '.[].name'
```
