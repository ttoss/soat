---
description: "A CloudFormation-inspired declarative layer that provisions an entire AI agent stack from a single JSON or YAML template."
---

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

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Deploy a Multi-Agent App with Agent Formation - Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template)
- [Deploy a Multi-Agent App with Agent Formation - Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation)
- [Deploy a Multi-Agent App with Agent Formation - Step 10 (Update the formation)](/docs/tutorials/formations#step-10--update-the-formation)
- [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — deploy a team of agents plus their coordinating orchestration as one stack

## Data Model

### Formation

| Field        | Type     | Description                                                                    |
| ------------ | -------- | ------------------------------------------------------------------------------ |
| `id`         | string   | Public ID (`form_` prefix)                                                       |
| `project_id` | string   | Project public ID                                                              |
| `name`       | string   | Formation name (unique per project)                                            |
| `template`   | object   | The last applied template (raw — substitution expressions preserved)          |
| `outputs`    | object   | Resolved output values                                                         |
| `status`     | string   | `creating` \| `active` \| `updating` \| `failed` \| `deleting` \| `deleted` \| `delete_failed` |
| `metadata`   | object   | Static annotations stored on the record (supplied at create/update). Not a substitution site — `sub`/`param`/`ref` expressions are rejected (use `template.metadata` instead) |
| `resolved_metadata`   | object   | The template's top-level `metadata` after `sub`/`param`/`ref` substitution at the last deploy (null when the template declares no metadata) |
| `resolved_parameters` | object   | Parameter values applied at the last deploy, for auditability (`no_echo` values masked as `***`; null when the template declares no parameters) |
| `resources`  | array    | Resources managed by the formation                                             |
| `created_at` | string   | ISO 8601 creation timestamp                                                    |
| `updated_at` | string   | ISO 8601 last-updated timestamp                                                |

### FormationResource

| Field                  | Type   | Description                                                         |
| ---------------------- | ------ | ------------------------------------------------------------------- |
| `id`                   | string | Public ID (`form_res_` prefix)                                           |
| `logical_id`           | string | Logical ID from the template                                        |
| `resource_type`        | string | Resource type (`agent`, `tool`, `memory`, etc.)                     |
| `physical_resource_id` | string | Public ID of the physical SOAT resource                             |
| `status`               | string | `pending` \| `created` \| `updated` \| `deleted` \| `failed`        |

### FormationOperation

| Field            | Type   | Description                                           |
| ---------------- | ------ | ----------------------------------------------------- |
| `id`             | string | Public ID (`form_op_` prefix)                             |
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
| `metadata`   | No       | Arbitrary metadata; supports `sub`/`param`/`ref` substitution (see [Metadata Substitution](#metadata-substitution)) |

#### Key Naming and Case

The template is stored and returned **verbatim** — SOAT does not rewrite its keys. This means two different naming rules apply inside a template:

- **Resource `properties` keys** must be **snake_case**, matching the REST API body fields (`default_model`, `ai_provider_id`). A camelCase property key is rejected at validation time as an unknown field.
- **Logical IDs, parameter names, and output names** are **author-chosen identifiers** and are preserved exactly as written — any case is accepted (`DefaultProvider`, `poemDoc`, `aiProviderName`). Use whatever convention you prefer, but stay consistent: a `--parameter` override must reference a parameter by the exact name declared in the template (`--parameter aiProviderName=…` matches a parameter declared as `aiProviderName`, not `ai_provider_name`).
- The deploy request's top-level **`parameters`** field (the value bag, not `template.parameters`) is likewise stored verbatim by key. A key must match the declared parameter name exactly, including underscores (`--parameter api_token=…` matches a parameter declared as `api_token`).

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

Pass parameter values in the `parameters` field of the validate, plan, create, or update request:

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
- On `validate-formation`, passing `parameters` is optional. When omitted, validation only checks the template's structure, so a required parameter without a default does not make the template invalid. When `parameters` is provided (even as an empty object), the validation result also reports any required parameter still missing after applying those values, as an entry in `errors`.

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

**Unset `@VAR_NAME` / bare-`KEY` variables omit the parameter, not fail the command**

If the referenced environment variable is not found (in `--env-file` or the shell), the CLI omits that parameter from the request instead of erroring — the server then decides: it reuses the formation's previously stored value for parameters declared `use_previous_value: true` (see [Reusing Previously Stored Values](#reusing-previously-stored-values)), or returns `400 Missing required parameters` if no previous value exists. `Key=$VAR` and `Key=${VAR}` keep failing fast in the CLI on an unset variable, since they are not tied to this fallback.

**Example — deploying with secrets from an `.env` file:**

Given `.env`:
```env
XAI_API_KEY=xai-...
TOOLS_API_KEY=tk-...
APP_URL=https://www.example.com
```

```bash
soat update-formation \
  --formation-id form_6sBFq1eBsCwB16dM \
  --template-file formation.yaml \
  --env-file .env \
  --parameter AppUrl=@APP_URL \
  --parameter ToolsApiKey=@TOOLS_API_KEY \
  --parameter XaiApiKey=@XAI_API_KEY
```

Or using the bare-key syntax (parameter name must match the env var name exactly):

```bash
soat update-formation \
  --formation-id form_6sBFq1eBsCwB16dM \
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
soat create-formation --project-id proj_xxx --name my-stack \
  --template-file formation.yaml --parameter XaiApiKey=@XAI_API_KEY

# Later deploys — omit it; the stored value is reused
soat update-formation --formation-id form_xxx --template-file formation.yaml

# Rotate it — supply a value; it overrides use_previous_value
soat update-formation --formation-id form_xxx --template-file formation.yaml \
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

- **`type`** — one of: `ai_provider`, `tool`, `agent`, `actor`, `api_key`, `chat`, `conversation`, `document`, `file`, `guardrail`, `ingestion_rule`, `memory`, `memory_entry`, `orchestration`, `policy`, `project_price`, `secret`, `session`, `webhook`, `trigger`, `workflow`. See [Formations Types](/docs/formations-types) for the full properties reference.
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

### Metadata Substitution

The template's top-level `metadata` block is a substitution site, exactly like `outputs`: `{ "ref": "logicalId" }`, `{ "param": "Name" }`, and `{ "sub": "text ${Name}" }` are resolved at deploy time. The raw expressions stay in `template.metadata` (so a re-deploy re-resolves them against new parameter values), and the resolved values are exposed on the formation's `resolved_metadata` field.

```yaml
parameters:
  my_version: { type: string, default: unpinned }
resources:
  MyMemory: { type: memory, properties: { name: shared } }
metadata:
  my_version: { sub: '${my_version}' }
  memory: { ref: MyMemory }
```

Deploying with `--parameter my_version=1.2.3` yields `resolved_metadata` of `{ "my_version": "1.2.3", "memory": "mem_01HXYZ" }`, while `template.metadata.my_version` remains `{ "sub": "${my_version}" }`.

The parameter values used on the last deploy are also recorded on `resolved_parameters` for auditability. Parameters declared `no_echo: true` are masked (`***`) so sensitive values are never persisted in plaintext.

:::warning The template `metadata` block is the only metadata substitution site
The formation-level `metadata` field — the one supplied alongside `template` on `create-formation` / `update-formation` (and returned as the formation's `metadata`) — is a **static** annotation bag. It is never resolved, so a `sub`/`param`/`ref` expression placed there would be stored verbatim and silently never substituted. To catch this, create/update **reject** such expressions in the formation `metadata` field with `400 FORMATION_INVALID_METADATA`. Put deploy-time substitutions in the template's top-level `metadata` block (above), which is resolved into `resolved_metadata`.
:::

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

Once a resource reaches `deleted`, it is a tombstone kept for audit history —
`get-formation` continues to list it, but it stops appearing as a live
change: `plan-formation` and `update-formation` only report a resource once,
at the deploy where it is actually removed from the template. A later no-op
reconcile never re-lists it. `plan-formation` also previews that pending
removal as a `delete` action before `update-formation` runs, so the two
always agree on the same set of changes.

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

### Plan Diff

Each entry in `plan-formation`'s `changes[]` array carries a `diff` object
alongside `logical_id`, `resource_type`, `action`, and `physical_resource_id`:

| Field           | Type          | Description                                                                          |
| --------------- | ------------- | ------------------------------------------------------------------------------------- |
| `diff.desired`  | object        | Resolved desired-state properties, after parameter and `ref`/`sub` substitution        |
| `diff.current`  | object \| null | Current properties being compared against — `null` when there is nothing to compare (a `create`, an unregistered resource type, or a failed read) |

For a resource type whose live state can be read back (most resource types),
`diff.current` reflects the resource as it exists today. For a write-only
resource type (currently only `secret`, whose value is encrypted at rest and
never read back), `diff.current` reflects the last-applied snapshot stored on
the formation resource instead — the same source of truth `update-formation`
diffs against, so `plan-formation` and `update-formation` agree on whether a
secret with `use_previous_value: true` is a `no-op`.

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
  --formation-id form_01 \
  --template-file formation.json \
  --parameter AppUrl=https://staging.example.com
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.formations.updateFormation({
  path: { formation_id: 'form_01' },
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
curl -X PUT https://api.example.com/api/v1/formations/form_01 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "template": { "resources": { ... } },
    "parameters": { "AppUrl": "https://staging.example.com" }
  }'
```

</TabItem>
</Tabs>

### Agent Squad

An [orchestration](./orchestrations.md) is itself a formation resource type, so a team of agents plus the flow that coordinates them can deploy as one stack — see the [Agent Squad example](./orchestrations.md#agent-squad) and the [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) tutorial.
