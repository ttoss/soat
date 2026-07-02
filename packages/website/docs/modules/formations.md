import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Formations

A CloudFormation-inspired declarative deployment layer that provisions an entire AI agent stack from a single JSON/YAML template.

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

SOAT detects that `MyAgent` depends on `MyProvider` and `MyMemory` through the `ref` expressions, creates them first, then creates the agent with the resolved physical IDs. See a 14-resource stack deployed in one call in [Deploy a Multi-Agent App with Agent Formation — Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation).

## Related Tutorials

- [Deploy a Multi-Agent App with Agent Formation - Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template)
- [Deploy a Multi-Agent App with Agent Formation - Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation)
- [Deploy a Multi-Agent App with Agent Formation - Step 10 (Update the formation)](/docs/tutorials/formations#step-10--update-the-formation)

## Data Model

### Formation

| Field        | Type     | Description                                                                    |
| ------------ | -------- | ------------------------------------------------------------------------------ |
| `id`         | string   | Public ID (`af_` prefix)                                                       |
| `project_id` | string   | Project public ID                                                              |
| `name`       | string   | Formation name (unique per project)                                            |
| `template`   | object   | The last applied template                                                      |
| `outputs`    | object   | Resolved output values                                                         |
| `status`     | string   | `creating` \| `active` \| `updating` \| `failed` \| `deleting` \| `deleted` \| `delete_failed` |
| `metadata`   | object   | Arbitrary metadata                                                             |
| `resources`  | array    | Resources managed by the formation                                             |
| `created_at` | string   | ISO 8601 creation timestamp                                                    |
| `updated_at` | string   | ISO 8601 last-updated timestamp                                                |

### FormationResource

| Field                  | Type   | Description                                                         |
| ---------------------- | ------ | ------------------------------------------------------------------- |
| `id`                   | string | Public ID (`afr_` prefix)                                           |
| `logical_id`           | string | Logical ID from the template                                        |
| `resource_type`        | string | Resource type (`agent`, `tool`, `memory`, etc.)                     |
| `physical_resource_id` | string | Public ID of the physical SOAT resource                             |
| `status`               | string | `pending` \| `created` \| `updated` \| `deleted` \| `failed`        |

### FormationOperation

| Field            | Type   | Description                                           |
| ---------------- | ------ | ----------------------------------------------------- |
| `id`             | string | Public ID (`afo_` prefix)                             |
| `operation_type` | string | `create` \| `update` \| `delete`                      |
| `status`         | string | `pending` \| `running` \| `succeeded` \| `failed`     |
| `plan`           | object | Planned changes computed before execution             |
| `events`         | array  | Per-resource event log with timestamp, action, status |
| `error`          | object | Error details if operation failed                     |
| `created_at`     | string | ISO 8601 creation timestamp                           |
| `updated_at`     | string | ISO 8601 last-updated timestamp                       |

## Key Concepts

### Formation Template

A template has four top-level keys. For a complete worked template wiring 14 resources together, see [Deploy a Multi-Agent App with Agent Formation — Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template).

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
      "type": "tool",
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

| Field         | Required | Description                                                                            |
| ------------- | -------- | -------------------------------------------------------------------------------------- |
| `type`               | No       | Parameter type; currently only `"string"` is supported                                                                  |
| `default`            | No       | Default value used when the parameter is not provided at deploy time                                                    |
| `description`        | No       | Human-readable description of the parameter's purpose                                                                   |
| `no_echo`            | No       | When `true`, signals that the value is sensitive and should not be logged or displayed                                  |
| `use_previous_value` | No       | When `true`, omitting the parameter **on update** reuses its previously stored value instead of failing as required     |

Parameters without a `default` are **required** — they must be provided in the `parameters` field of the deploy request, unless declared with `use_previous_value: true` (see [Reusing Previously Stored Values](#reusing-previously-stored-values)).

#### Parameter Expressions

Use these expressions anywhere in `properties` or `outputs` to reference a parameter:

| Expression                       | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| `{ "param": "ParamName" }`       | Replaced with the parameter's value as-is                                |
| `{ "sub": "text ${ParamName}" }` | String interpolation — embeds the parameter value inside a larger string |

A `${Name}` token inside a `sub` may also name a resource logical ID, which resolves to the resource's physical public ID at apply time — see [Sub Expressions](#sub-expressions).

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
- Parameters without a `default` and not provided in the request cause a `400 Missing required parameters` error — unless declared `use_previous_value: true`, which reuses the stored value on update (see [Reusing Previously Stored Values](#reusing-previously-stored-values)).
- Parameter values are **never stored** in the database — provide them on every create/update call, except for `use_previous_value` parameters on update.

#### Providing Parameter Values via the CLI

The CLI accepts `--parameter` (repeatable) instead of a JSON `--parameters` object. It also accepts `--env-file` to load an `.env` file so that sensitive values never need to be hardcoded in the command.

**Syntax options for `--parameter`:**

| Syntax | Example | When to use |
|---|---|---|
| `Key=literal` | `--parameter AppUrl=https://example.com` | Non-sensitive, static values |
| `Key=$VAR` or `Key=${VAR}` | `--parameter ApiKey=$API_KEY` | Variable already exported in the shell |
| `Key=@VAR_NAME` | `--parameter ApiKey=@API_KEY` | Variable in `--env-file`; shell-safe (no expansion) |
| `KEY` (no `=`) | `--parameter API_KEY` | Read env var by exact name from `--env-file` or shell env |

**Why `$VAR` breaks with `--env-file`**

The shell expands `$VAR` to an empty string before the CLI process starts, so `--env-file` loading always arrives too late when variables are not exported in the calling shell. Use `@VAR_NAME` or the bare-key syntax instead — neither is interpreted by the shell.

**Example — deploying with secrets from an `.env` file:**

Given `.env`:
```env
XAI_API_KEY=xai-...
TOOLS_API_KEY=tk-...
APP_URL=https://www.example.com
```

```bash
soat update-formation \
  --formation-id af_6sBFq1eBsCwB16dM \
  --template-file formation.yaml \
  --env-file .env \
  --parameter AppUrl=@APP_URL \
  --parameter ToolsApiKey=@TOOLS_API_KEY \
  --parameter XaiApiKey=@XAI_API_KEY
```

Or using the bare-key syntax (parameter name must match the env var name exactly):

```bash
soat update-formation \
  --formation-id af_6sBFq1eBsCwB16dM \
  --template-file formation.yaml \
  --env-file .env \
  --parameter APP_URL \
  --parameter TOOLS_API_KEY \
  --parameter XAI_API_KEY
```

**Lookup order:** `--env-file` variables are checked first; if not found there, `process.env` (the calling shell's exported variables) is checked. Missing variables cause the CLI to exit with an error before the API call is made.

#### Reusing Previously Stored Values

Declare a parameter with `use_previous_value: true` to let an **update** reuse its previously stored value instead of re-supplying it — the equivalent of AWS CloudFormation's `UsePreviousValue`, but declared in the template. This lets a deploy pipeline update part of a formation without holding every secret value.

```yaml
parameters:
  XaiApiKey:
    type: string
    no_echo: true
    use_previous_value: true # omit on update → reuse the stored value
resources:
  XaiKey:
    type: secret
    properties:
      name: xai-api-key
      value: { param: XaiApiKey }
```

```bash
# First deploy — supply the value (create has no previous value to reuse)
soat create-formation --project-id prj_xxx --name my-stack \
  --template-file formation.yaml --parameter XaiApiKey=@XAI_API_KEY

# Later deploys — omit it; the stored value is reused
soat update-formation --formation-id af_xxx --template-file formation.yaml

# Rotate it — supply a value; it overrides use_previous_value
soat update-formation --formation-id af_xxx --template-file formation.yaml \
  --parameter XaiApiKey=@XAI_API_KEY
```

Rules:

- An explicitly supplied value **always overrides** `use_previous_value`, so rotation still works by passing the parameter.
- `use_previous_value` only satisfies the required-parameter check **on update**. On create there is no previous value, so an omitted parameter still returns `400 Missing required parameters`.
- A parameter **without** `use_previous_value` that is neither supplied nor defaulted still returns `400 Missing required parameters` — so a missing value fails loudly rather than silently freezing an unrelated parameter.
- The previous value is reused only where the underlying resource retains it. A `secret` resource's encrypted value is preserved untouched (its plaintext is never stored), producing a no-op for that resource. For other resources, the **last-applied** value of that field is reused; fields that were never stored are simply dropped.

### Resource Declaration

```json
{
  "type": "agent",
  "properties": { ... },
  "depends_on": ["OtherLogicalId"],
  "deletion_policy": "retain",
  "metadata": { }
}
```

- **`type`** — one of: `ai_provider`, `tool`, `agent`, `actor`, `api_key`, `chat`, `conversation`, `document`, `file`, `ingestion_rule`, `memory`, `memory_entry`, `policy`, `secret`, `session`, `webhook`. See [Formations Types](/docs/formations-types) for the full properties reference.
- **`properties`** — resource-specific properties (snake_case, matching the REST API body fields)
- **`depends_on`** — explicit dependency list in addition to implicit `ref` dependencies
- **`deletion_policy`** — controls what happens to the physical resource when it is removed from the stack. `delete` (default) deletes the physical resource. `retain` keeps the physical resource alive and only removes the formation record.
- **`metadata`** — arbitrary key/value stored on the resource record

### Ref Expressions

Use `{ "ref": "LogicalId" }` anywhere in a `properties` value (or in `outputs`) to substitute the physical public ID of another resource once it is created:

```json
"ai_provider_id": { "ref": "MyProvider" }
```

Refs create implicit dependencies — no need to repeat them in `depends_on`.

### Sub Expressions

`{ "sub": "..." }` interpolates values **inside** a string. A `${Name}` token inside a sub resolves to:

- the parameter's value, when `Name` is declared in `parameters`;
- the **physical public ID** of another resource, when `Name` is a resource logical ID (resolved at apply time, like a `ref`);
- itself (left literal), when `Name` starts with `body.` — those are [tool-argument interpolations](./tools.md#http) resolved at tool-call time.

Resource logical IDs inside subs create implicit dependencies, exactly like `ref` expressions.

The main use case is embedding a [secret reference](./secrets.md#secret-references-secret) for a secret created in the same template — the sub resolves the logical ID to the `sec_...` physical ID, producing a stored `{{secret:sec_...}}` token that the tool resolves at call time:

```json
{
  "resources": {
    "ApiSecret": {
      "type": "secret",
      "properties": { "name": "third-party-api-key", "value": "sk-live-..." }
    },
    "ConvertTool": {
      "type": "tool",
      "properties": {
        "name": "convert-document",
        "type": "http",
        "execute": {
          "url": "https://api.example.com/convert",
          "method": "POST",
          "headers": {
            "Authorization": { "sub": "Bearer {{secret:${ApiSecret}}}" }
          }
        }
      }
    }
  }
}
```

After deployment the tool's stored header is `Bearer {{secret:sec_01HXYZ}}` — the decrypted value is only substituted server-side when the tool is called, and is never echoed back by any API response.

### Topological Ordering

SOAT builds a dependency graph from explicit `depends_on` entries, implicit `ref` expressions, and resource logical IDs referenced inside `sub` strings, then uses topological sort (Kahn's algorithm) to determine the creation order. A template with a cycle fails validation.

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

Deletion is idempotent: if a managed resource was already removed outside of
the formation (for example, deleted directly through its own REST endpoint),
teardown treats it as already gone rather than failing the stack. Only
unexpected errors mark the operation `failed` and leave the stack in
`delete_failed`.

### Operations and Event Log

Every deploy (create, update, delete) creates a `FormationOperation` record with:

- `operation_type` — `create | update | delete`
- `status` — `pending | running | succeeded | failed`
- `plan` — the planned changes computed before execution
- `events` — ordered list of per-resource events with timestamp, action, status, and error (if any)

Use `GET /api/v1/formations/{formation_id}/events` to retrieve the full history.

## Examples

### Deploy a formation

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-formation \
  --project-id "$PROJECT_ID" \
  --name "my-stack" \
  --template-file formation.json
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.formations.createFormation({
  body: {
    project_id: 'proj_ABC',
    name: 'my-stack',
    template: {
      resources: {
        MyProvider: {
          type: 'ai_provider',
          properties: { name: 'GPT-4o', provider: 'openai', default_model: 'gpt-4o' },
        },
        MyAgent: {
          type: 'agent',
          properties: {
            name: 'Support Bot',
            ai_provider_id: { ref: 'MyProvider' },
            instructions: 'You are a helpful assistant.',
          },
        },
      },
      outputs: { agentId: { ref: 'MyAgent' } },
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
// data.outputs.agentId contains the provisioned agent's public ID
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/formations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "my-stack",
    "template": {
      "resources": {
        "MyProvider": {
          "type": "ai_provider",
          "properties": { "name": "GPT-4o", "provider": "openai", "default_model": "gpt-4o" }
        },
        "MyAgent": {
          "type": "agent",
          "properties": {
            "name": "Support Bot",
            "ai_provider_id": { "ref": "MyProvider" },
            "instructions": "You are a helpful assistant."
          }
        }
      },
      "outputs": { "agentId": { "ref": "MyAgent" } }
    }
  }'
```

</TabItem>
</Tabs>

### Update a formation

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-formation \
  --formation-id af_01 \
  --template-file formation.json \
  --parameter AppUrl=https://staging.example.com
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.formations.updateFormation({
  path: { formation_id: 'af_01' },
  body: {
    template: { /* updated template */ },
    parameters: { AppUrl: 'https://staging.example.com' },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PUT https://api.example.com/api/v1/formations/af_01 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "template": { "resources": { ... } },
    "parameters": { "AppUrl": "https://staging.example.com" }
  }'
```

</TabItem>
</Tabs>
