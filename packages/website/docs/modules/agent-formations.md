# Agent Formations

Agent Formations is a CloudFormation-inspired declarative deployment layer that lets you describe an entire AI agent stack in a single JSON/YAML template and deploy it with one API call. SOAT resolves resource dependencies automatically, provisions resources in the correct order, and tracks every change in an immutable event log.

> **Note:** Creating a formation also creates underlying resources (agents, memories, etc.). The calling identity must also have the relevant `agents:CreateAgent`, `memories:CreateMemory`, etc. permissions.

## Overview

Instead of making a dozen separate API calls to create an AI provider, memory, agent tool, and agent, you write a single template:

```json
{
  "resources": {
    "MyProvider": {
      "type": "ai_provider",
      "properties": {
        "name": "My OpenAI",
        "provider": "openai",
        "default_model": "gpt-4o"
      }
    },
    "MyMemory": {
      "type": "memory",
      "properties": {
        "name": "Product KB"
      }
    },
    "MyAgent": {
      "type": "agent",
      "properties": {
        "name": "Support Bot",
        "ai_provider_id": { "ref": "MyProvider" },
        "knowledge_config": {
          "memory_ids": [{ "ref": "MyMemory" }]
        }
      }
    }
  },
  "outputs": {
    "agentId": { "ref": "MyAgent" }
  }
}
```

SOAT detects that `MyAgent` depends on `MyProvider` and `MyMemory` through the `ref` expressions, creates them first, then creates the agent with the resolved physical IDs.

## Key Concepts

### Formation Template

A template has four top-level keys:

| Key          | Required | Description                                                  |
| ------------ | -------- | ------------------------------------------------------------ |
| `parameters` | No       | Map of parameter names → parameter declarations              |
| `resources`  | Yes      | Map of logical resource ID → resource declaration            |
| `outputs`    | No       | Map of output names → values (may contain `ref` expressions) |
| `metadata`   | No       | Arbitrary metadata stored with the formation                 |

### Parameters

Parameters make a template portable across environments by allowing deploy-time values to be injected without changing the template itself. Use the `parameters` key to declare them:

```json
{
  "parameters": {
    "AppUrl": {
      "type": "string",
      "default": "https://www.example.com",
      "description": "Public base URL of the application"
    },
    "ApiKey": {
      "type": "string",
      "no_echo": true,
      "description": "Bearer token for API requests"
    },
    "SecretId": {
      "type": "string",
      "description": "SOAT secret ID for the AI provider"
    }
  },
  "resources": {
    "MyProvider": {
      "type": "ai_provider",
      "properties": {
        "name": "My Provider",
        "provider": "xai",
        "secret_id": { "param": "SecretId" }
      }
    },
    "MyTool": {
      "type": "agent_tool",
      "properties": {
        "name": "my-tool",
        "execute": {
          "url": { "sub": "${AppUrl}/api/endpoint" },
          "headers": { "Authorization": { "sub": "Bearer ${ApiKey}" } }
        }
      }
    }
  }
}
```

#### Parameter Declaration Fields

| Field         | Required | Description                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `type`        | No       | Parameter type; currently only `"string"` is supported                         |
| `default`     | No       | Default value used when the parameter is not provided at deploy time            |
| `description` | No       | Human-readable description of the parameter's purpose                          |
| `no_echo`     | No       | When `true`, signals that the value is sensitive and should not be logged or displayed |

Parameters without a `default` are **required** — they must be provided in the `parameters` field of the deploy request.

#### Parameter Expressions

Use these expressions anywhere in `properties` or `outputs` to reference a parameter:

| Expression                    | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `{ "param": "ParamName" }`    | Replaced with the parameter's value as-is           |
| `{ "sub": "text ${ParamName}" }` | String interpolation — embeds the parameter value inside a larger string |

#### Providing Parameter Values

Pass parameter values in the `parameters` field of the create or update request:

```json
{
  "project_id": "proj_xxx",
  "name": "my-stack",
  "template": { ... },
  "parameters": {
    "AppUrl": "https://staging.example.com",
    "ApiKey": "sk-secret",
    "SecretId": "sec_abc123"
  }
}
```

- Values in `parameters` override any `default` declared in the template.
- Parameters with a `default` are optional in the request.
- Parameters without a `default` and not provided in the request cause a `400 Missing required parameters` error.
- Parameter values are **never stored** in the database — provide them on every create/update call.

### Resource Declaration

```json
{
  "type": "agent",
  "properties": { ... },
  "depends_on": ["OtherLogicalId"],
  "metadata": { }
}
```

- **`type`** — one of: `ai_provider`, `agent_tool`, `agent`, `document`, `memory`, `memory_entry`, `webhook`
- **`properties`** — resource-specific properties (snake_case, matching the REST API body fields)
- **`depends_on`** — explicit dependency list in addition to implicit `ref` dependencies
- **`metadata`** — arbitrary key/value stored on the resource record

### Ref Expressions

Use `{ "ref": "LogicalId" }` anywhere in a `properties` value (or in `outputs`) to substitute the physical public ID of another resource once it is created:

```json
"ai_provider_id": { "ref": "MyProvider" }
```

Refs create implicit dependencies — no need to repeat them in `depends_on`.

### Topological Ordering

SOAT builds a dependency graph from both explicit `depends_on` entries and implicit `ref` expressions, then uses topological sort (Kahn's algorithm) to determine the creation order. A template with a cycle fails validation.

### Resource Lifecycle

Each resource in a formation goes through these statuses:

| Status    | Meaning                                     |
| --------- | ------------------------------------------- |
| `pending` | Not yet provisioned                         |
| `created` | Successfully created by a formation deploy  |
| `updated` | Successfully updated by a subsequent deploy |
| `deleted` | Deleted when removed from the template      |
| `failed`  | Last operation failed                       |

The formation stack itself has these statuses:

| Status          | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| `creating`      | First deployment in progress                             |
| `active`        | All resources provisioned successfully                   |
| `updating`      | A template update is in progress                         |
| `failed`        | Last deployment ended with one or more resource failures |
| `deleting`      | Stack teardown in progress                               |
| `deleted`       | All resources removed                                    |
| `delete_failed` | Stack teardown encountered failures                      |

### Operations and Event Log

Every deploy (create, update, delete) creates a `FormationOperation` record with:

- `operation_type` — `create | update | delete`
- `status` — `pending | running | succeeded | failed`
- `plan` — the planned changes computed before execution
- `events` — ordered list of per-resource events with timestamp, action, status, and error (if any)

Use `GET /api/v1/agent-formations/{formation_id}/events` to retrieve the full history.

## Data Model

### AgentFormation

| Field        | Type     | Description                         |
| ------------ | -------- | ----------------------------------- |
| `id`         | string   | Public ID (`af_…`)                  |
| `project_id` | string   | Project public ID                   |
| `name`       | string   | Formation name (unique per project) |
| `template`   | object   | The last applied template           |
| `outputs`    | object   | Resolved output values              |
| `status`     | string   | Formation status                    |
| `metadata`   | object   | Arbitrary metadata                  |
| `resources`  | array    | Resources managed by the formation  |
| `created_at` | datetime |                                     |
| `updated_at` | datetime |                                     |

### AgentFormationResource

| Field                  | Type   | Description                             |
| ---------------------- | ------ | --------------------------------------- |
| `id`                   | string | Public ID (`afr_…`)                     |
| `logical_id`           | string | Logical ID from the template            |
| `resource_type`        | string | Resource type                           |
| `physical_resource_id` | string | Public ID of the physical SOAT resource |
| `status`               | string | Resource status                         |

### FormationOperation

| Field            | Type     | Description                       |
| ---------------- | -------- | --------------------------------- | ------ | ------- |
| `id`             | string   | Public ID (`afo_…`)               |
| `operation_type` | string   | `create                           | update | delete` |
| `status`         | string   | Operation status                  |
| `plan`           | object   | Planned changes                   |
| `events`         | array    | Per-resource event log            |
| `error`          | object   | Error details if operation failed |
| `created_at`     | datetime |                                   |
| `updated_at`     | datetime |                                   |

