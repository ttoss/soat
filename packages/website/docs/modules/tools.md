import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Tools

Standalone, reusable tool definitions that can be attached to agents and invoked directly via the API.

## Overview

The Tools module lets you define callable tools that agents use during generation. A tool encapsulates its type, input schema, and execution config in one record. Tools are project-scoped and can be shared across multiple agents.

Four tool types are supported:

| Type     | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `http`   | Calls an external HTTP endpoint with the model's arguments                           |
| `client` | Signals the calling client to execute a UI action (e.g. show a dialog)               |
| `mcp`    | Proxies a call to an MCP (Model Context Protocol) server                             |
| `soat`   | Invokes a SOAT platform action (e.g. `files:ListFiles`, `documents:SearchDocuments`) |

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Tool

| Field               | Type                                          | Description                                                                                                       |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                | `string`                                      | Public ID (`tool_` prefix)                                                                                        |
| `project_id`        | `string`                                      | ID of the owning project                                                                                          |
| `name`              | `string`                                      | Machine-readable tool name sent to the model                                                                      |
| `type`              | `"http"` \| `"client"` \| `"mcp"` \| `"soat"` | Tool type                                                                                                         |
| `description`       | `string\|null`                                | Human-readable description sent to the model                                                                      |
| `parameters`        | `object\|null`                                | JSON Schema describing the tool's input                                                                           |
| `execute`           | `object\|null`                                | HTTP execution config (`url`, `method`, `headers`). The `url` supports `{paramName}` path placeholders.           |
| `mcp`               | `object\|null`                                | MCP server config (`url`, `headers`)                                                                              |
| `actions`           | `string[]\|null`                              | SOAT platform actions to expose (e.g. `["files:ListFiles"]`). Only for `soat` type.                               |
| `preset_parameters` | `object\|null`                                | Fixed parameter values merged into every call. These fields are hidden from the model and injected automatically. |
| `created_at`        | `string`                                      | ISO 8601 creation timestamp                                                                                       |
| `updated_at`        | `string`                                      | ISO 8601 last-updated timestamp                                                                                   |

## Key Concepts

### HTTP Tools

HTTP tools call an external URL when invoked. The `execute.url` field supports `{paramName}` placeholders that are replaced with the corresponding argument value at call time. Arguments consumed as path parameters are excluded from the request body.

```json
{
  "name": "get-weather",
  "type": "http",
  "description": "Fetches current weather for a city",
  "parameters": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"]
  },
  "execute": {
    "url": "https://api.weather.example/v1/current?city={city}",
    "method": "GET"
  }
}
```

### SOAT Tools

SOAT tools expose one or more SOAT platform actions to the model. The `actions` array lists the action strings (e.g. `files:ListFiles`). At call time, the caller supplies an `action` discriminant to select which action to run.

`preset_parameters` lets you inject fixed arguments invisibly. For example, pinning a `documentId` means the model never needs to know or supply it.

```json
{
  "name": "docs-search",
  "type": "soat",
  "actions": ["documents:SearchDocuments"],
  "preset_parameters": { "documentId": "doc_abc123" }
}
```

### Client Tools

Client tools (`type: client`) are not executed by the server. When an agent produces a client tool call, the generation status transitions to `requires_action`. The calling application is responsible for executing the action and submitting the result back via `POST /agents/{agent_id}/generate/{generation_id}/tool-outputs`.

### MCP Tools

MCP tools proxy a call to an external MCP server. The `mcp` field contains `url` and optional `headers` for the server connection.

### Calling a Tool Directly

Tools can be invoked independently of an agent via `POST /api/v1/tools/{tool_id}/call`. The request body accepts `action` (required for `soat` and `mcp` types) and `input` (key-value arguments).

## Examples

<Tabs>
<TabItem value="cli" label="CLI">

```bash
# Create an HTTP tool
soat create-tool \
  --name "get-weather" \
  --type http \
  --description "Fetches current weather" \
  --execute '{"url":"https://api.weather.example/v1/current?city={city}","method":"GET"}' \
  --parameters '{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}'

# List tools in a project
soat list-tools --project-id "$PROJECT_ID"

# Call a tool directly
soat call-tool --tool-id "$TOOL_ID" --input '{"city":"São Paulo"}'
```

</TabItem>
<TabItem value="rest" label="REST">

```bash
# Create a SOAT tool
curl -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "list-files",
    "type": "soat",
    "description": "Lists files in the project",
    "actions": ["files:ListFiles"]
  }'

# Call a tool directly
curl -X POST "$SOAT_BASE_URL/api/v1/tools/$TOOL_ID/call" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"files:ListFiles","input":{}}'
```

</TabItem>
</Tabs>
