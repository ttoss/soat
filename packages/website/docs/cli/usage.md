---
sidebar_position: 2
---

# Usage Examples

Common workflows using the SOAT CLI. All examples assume a configured profile — see [Introduction](./introduction.md) for setup.

## Configure a Profile

```bash
soat configure
# Profile name (leave blank for "default"): default
# Base URL: http://localhost:5047
# Token: <your-jwt-or-sdk-key>
```

Use `--profile` to work with multiple environments:

```bash
soat configure
# Profile name: prod
# Base URL: https://api.example.com
# Token: sk_...

soat --profile prod list-actors --project_id prj_01
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
soat get-project --id prj_01
```

## Actors

```bash
# List actors for a project
soat list-actors --project_id prj_01

# Create an actor
soat create-actor --name "Support Bot" --type ai --project_id prj_01

# Get a specific actor
soat get-actor --id act_01

# Delete an actor
soat delete-actor --id act_01
```

## Files

```bash
# List files in a project
soat list-files --project_id prj_01

# Get a specific file
soat get-file --id file_01

# Delete a file
soat delete-file --id file_01
```

## Passing Body Fields

All request body fields are passed as `--flag value` arguments. Field names match the snake_case REST API contract:

```bash
soat create-actor --name "My Bot" --type ai --project_id prj_01
soat update-actor --id act_01 --name "Renamed Bot"
```

## JSON Output

Every command prints the API response as formatted JSON:

```bash
soat get-actor --id act_01
# {
#   "id": "act_01",
#   "name": "Support Bot",
#   "type": "ai",
#   ...
# }
```

Pipe to `jq` for filtering:

```bash
soat list-actors --project_id prj_01 | jq '.[].name'
```
