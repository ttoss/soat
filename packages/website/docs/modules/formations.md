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
| `error`      | object   | Why the formation is `failed` / `delete_failed`, as `{ code, message, meta }` — the same shape an error response uses. Null in every other status, and cleared by the next successful deploy |
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

Every deploy (create, update, delete) creates one of these records; [`GET /api/v1/formations/{formation_id}/events`](/docs/api/formations/list-formation-events) returns the full history.

| Field            | Type   | Description                                           |
| ---------------- | ------ | ----------------------------------------------------- |
| `id`             | string | Public ID (`form_op_` prefix)                             |
| `operation_type` | string | `create` \| `update` \| `delete`                      |
| `status`         | string | `pending` \| `running` \| `succeeded` \| `failed`     |
| `plan`           | object | Planned changes computed before execution             |
| `events`         | array  | Per-resource event log with timestamp, action, status |
| `error`          | object | Why this operation failed, as `{ code, message, meta }` — the same bag the formation carries while that failure is its current state. Null otherwise |
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

The template is stored and returned **verbatim** — SOAT does not rewrite its keys:

- **Resource `properties` keys** must be **snake_case**, matching the REST API body fields (`default_model`, `ai_provider_id`). A camelCase property key is rejected at validation time as an unknown field.
- **A property with declared allowed values is checked at validation time**, not at deploy time. `validate-formation` and `plan-formation` both refuse `"provider": "openia"` before anything is created; the accepted values for every property are listed on its type's page under [Formations Types](/docs/formations-types).
- **Logical IDs, parameter names, and output names** are **author-chosen identifiers**, preserved exactly as written — any case is accepted. A `--parameter` override (and any key in the deploy request's top-level `parameters` value bag) must match the declared parameter name exactly, including underscores (`--parameter aiProviderName=…` matches `aiProviderName`, not `ai_provider_name`).

### Parameters

Parameters make a template portable across environments by injecting deploy-time values without changing the template:

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

#### Parameter Expressions

Use these expressions anywhere in `properties` or `outputs`:

| Expression                       | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| `{ "param": "ParamName" }`       | Replaced with the parameter's value as-is                                |
| `{ "sub": "text ${ParamName}" }` | String interpolation — embeds the parameter value inside a larger string |

A `${Name}` token inside a `sub` may also name a resource logical ID — see [Sub Expressions](#sub-expressions).

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

- Values in `parameters` override any `default`; parameters with a `default` are optional in the request.
- Parameters without a `default` and not provided cause a `400 Missing required parameters` error — unless declared `use_previous_value: true`, which reuses the stored value on update (see [Reusing Previously Stored Values](#reusing-previously-stored-values)).
- Parameter values are **never stored** in the database — provide them on every create/update call, except for `use_previous_value` parameters on update.
- On `validate-formation`, `parameters` is optional. When omitted, validation only checks the template's structure, so a required parameter without a default does not make the template invalid. When provided (even as an empty object), the result also reports any still-missing required parameter as an entry in `errors`.

#### Providing Parameter Values via the CLI

The CLI accepts `--parameter` (repeatable) instead of a JSON `--parameters` object, plus `--env-file` to load an `.env` file so sensitive values never need to be hardcoded.

| Syntax | Example | When to use |
|---|---|---|
| `Key=literal` | `--parameter AppUrl=https://example.com` | Non-sensitive, static values |
| `Key=$VAR` or `Key=${VAR}` | `--parameter ApiKey=$API_KEY` | Variable already exported in the shell |
| `Key=@VAR_NAME` | `--parameter ApiKey=@API_KEY` | Variable in `--env-file`; shell-safe (no expansion) |
| `KEY` (no `=`) | `--parameter API_KEY` | Read env var by exact name from `--env-file` or shell env |

The shell expands `$VAR` before the CLI starts, so it cannot pick up `--env-file` values — use `@VAR_NAME` or the bare-key syntax for those. Lookup order: `--env-file` first, then `process.env`. When an `@VAR_NAME` / bare-`KEY` variable is not found, the CLI **omits that parameter** from the request instead of erroring — the server then reuses the stored value for `use_previous_value: true` parameters or returns `400 Missing required parameters`. `Key=$VAR` / `Key=${VAR}` keep failing fast in the CLI on an unset variable.

```bash
soat update-formation \
  --formation-id form_6sBFq1eBsCwB16dM \
  --template-file formation.yaml \
  --env-file .env \
  --parameter AppUrl=@APP_URL \
  --parameter TOOLS_API_KEY \
  --parameter XAI_API_KEY
```

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

Rules:

- An explicitly supplied value **always overrides** `use_previous_value`, so rotation still works by passing the parameter.
- `use_previous_value` only satisfies the required-parameter check **on update**. On create there is no previous value, so an omitted parameter still returns `400 Missing required parameters`.
- A parameter **without** `use_previous_value` that is neither supplied nor defaulted still returns `400 Missing required parameters` — a missing value fails loudly rather than silently freezing an unrelated parameter.
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

- **`type`** — a built-in type (`ai_provider`, `tool`, `agent`, `actor`, `api_key`, `chat`, `conversation`, `dataset`, `dataset_item`, `document`, `file`, `guardrail`, `ingestion_rule`, `memory`, `memory_entry`, `model_route`, `eval`, `orchestration`, `policy`, `project_price`, `quota`, `secret`, `session`, `webhook`, `trigger`, `workflow`) or a [custom resource type](#custom-resource-types) the deployment registered. See [Formations Types](/docs/formations-types) for the full properties reference of the built-in ones.
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

The template's top-level `metadata` block is a substitution site, exactly like `outputs`: `{ "ref": "logicalId" }`, `{ "param": "Name" }`, and `{ "sub": "text ${Name}" }` are resolved at deploy time. The raw expressions stay in `template.metadata` (so a re-deploy re-resolves them against new parameter values), and the resolved values are exposed on the formation's `resolved_metadata` field. The parameter values used on the last deploy are recorded on `resolved_parameters`, with `no_echo: true` values masked (`***`).

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

:::warning[The template `metadata` block is the only metadata substitution site]
The formation-level `metadata` field — the one supplied alongside `template` on `create-formation` / `update-formation` — is a **static** annotation bag, never resolved. Create/update **reject** `sub`/`param`/`ref` expressions there with `400 FORMATION_INVALID_METADATA`; put deploy-time substitutions in the template's top-level `metadata` block instead.
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
| `deleted` | Deleted when removed from the template, or rolled back after a failed deploy |
| `failed`  | Last operation failed                       |

A resource that a deploy **replaced** — see
[Custom Resource Types](#custom-resource-types) — stays `updated`, with its
`physical_resource_id` re-pointed at the replacement. The deploy records a
`replace` event, followed by a `replace-cleanup` event for the disposal of the
old resource (or `replace-retained` when `deletion_policy` is `retain`).

Once a resource reaches `deleted`, it is a tombstone kept for audit history —
`get-formation` continues to list it, but `plan-formation` and
`update-formation` only report it once, at the deploy where it is actually
removed from the template; a later no-op reconcile never re-lists it.
`plan-formation` previews the pending removal as a `delete` action, so the two
always agree on the same set of changes.

### A Failed Deploy Still Answers 2xx

A formation deploy is a **reconciler**, so the two failure kinds are reported
differently:

| What went wrong | How it is reported |
| --- | --- |
| The template's **shape** — an unknown field, a missing required property, a bad `ref` | `400 VALIDATION_FAILED`, nothing is deployed |
| The **reconciliation** — a resource the platform refused to create or update | `201`/`200` with `status: "failed"` and a populated `error` |

The second is not an error response, because the operation genuinely ran:
resources may have been created and walked back, and partial failure is state on
the stack. So **`2xx` means the deploy was attempted, not that it worked** — read
`status`.

`error` on that response says why, without a second call:

```json
{
  "id": "form_V1StGXR8Z5jdHi6B",
  "status": "failed",
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "dataset_id is immutable: item 'dsit_…' belongs to 'dset_…'. Declare a new dataset_item instead.",
    "meta": { "logical_id": "case1", "resource_type": "dataset_item" }
  }
}
```

It stays readable on `get-formation` for as long as the stack is `failed`, and
the next successful deploy clears it. `list-formation-events` remains the
history — every operation, each with the same `error` bag.

**The CLI exits non-zero on that body.** `create-formation` and
`update-formation` still print the payload to stdout (so `$(…)` capture and
`| jq` are unaffected), then write the reason to stderr and exit `1`:

```bash
soat update-formation --formation-id "$F" --template "$T" && echo "deployed"
# update-formation: the deploy failed at resource 'case1' — the formation is
# 'failed'. VALIDATION_FAILED: dataset_id is immutable: …
# (exit 1 — "deployed" is not printed)
```

Reads are unaffected: `get-formation` on a `failed` stack is a successful read
and exits `0`. So is `plan-formation` / `validate-formation`, whose outcome is
their payload.

### Rollback on a Failed Deploy

A deploy stops at the first resource that fails, and every resource it
**created** earlier in that same deploy is walked back — in reverse dependency
order, so a dependency is only removed after its dependents. The stack ends up
`failed` with nothing new left standing, and a corrected re-deploy re-creates
those resources from scratch instead of colliding with half-provisioned ones.

Two things are deliberately left alone:

- A resource that was **updated**, not created, keeps its new state. Restoring
  it would need a pre-update snapshot the deploy does not take.
- A resource declared `deletion_policy: retain` survives, and its formation
  record keeps pointing at it, so the next deploy adopts it rather than
  provisioning a duplicate.

Each unwind is recorded in the operation's `events`, after the failure that
triggered it: `rollback` (`succeeded` or `failed`) for a resource that was
walked back, `rollback-skipped` for a retained one. A `rollback` that itself
fails is reported, never thrown — the original error stays the one the
operation's `error` field names — and that resource's record stays pointing at
the physical resource so it can be cleaned up by hand.

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

Deletion is idempotent: a managed resource already removed outside the
formation is treated as already gone. A teardown that cannot finish answers
`409 FORMATION_DELETE_FAILED` and names every blocking resource in
`error.meta.failures`, each as `{ logical_id, resource_type, error }`.

**A predictable blocker is caught before anything is deleted.** Teardown
pre-flights the resources it is about to remove, so a refusal it can foresee
fails the whole operation having destroyed nothing: the stack stays `active` and
intact, and the same `delete-formation` succeeds once the blocker is resolved.
The one such blocker today is an **agent with generation or trace history**,
which the platform never force-deletes on its own — that stays an explicit
operator decision via [`DELETE /api/v1/agents/{agent_id}?force=true`](/docs/api/agents/delete-agent). Declare the
agent with `deletion_policy: retain` if the stack should leave it standing; a
retained resource is never deleted, so it never blocks.

This matters most for the stacks the docs recommend. An eval run is *defined* as
one generation per dataset item, so a template shipping an agent together with
the eval that verifies it has a history-bearing agent the moment the suite runs
— see [Gate a Canary Promotion on an Eval](../tutorials/gate-a-canary-promotion-on-an-eval.md).

An **unforeseeable** error — one no pre-flight can predict — still surfaces
mid-teardown. There, resources removed before the blocker stay removed
(teardown does not roll back) and the stack is left in `delete_failed`; the
error message says which case you are in. Resolve the blockers and delete again.

### Plan Diff

Each entry in `plan-formation`'s `changes[]` array carries a `diff` object
alongside `logical_id`, `resource_type`, `action`, and `physical_resource_id`:

| Field           | Type          | Description                                                                          |
| --------------- | ------------- | ------------------------------------------------------------------------------------- |
| `diff.desired`  | object        | Resolved desired-state properties, after parameter and `ref`/`sub` substitution        |
| `diff.current`  | object \| null | Current properties being compared against — `null` when there is nothing to compare (a `create`, an unregistered resource type, or a failed read) |

For a resource type whose live state can be read back (most), `diff.current`
reflects the resource as it exists today. For a write-only resource type
(currently only `secret`), `diff.current` reflects the last-applied snapshot
stored on the formation resource — the same source of truth
`update-formation` diffs against.

Both commands apply the same change rule, so a plan never disagrees with the
apply it previews:

- Only properties **the template declares** are compared. A field the resource
  carries but the template omits — set out of band, or removed from the
  template — is not a change.
- A declared property is compared **structurally**, so key order inside a
  nested value bag is not a change.
- A property resolving to `undefined` (a kept `use_previous_value` parameter)
  reuses the previous value, or is dropped entirely when there is none.

### Custom Resource Types

A deployment that builds its own product on top of SOAT usually has resources
SOAT knows nothing about — a messaging channel, a routing rule. Those can be
declared in a formation template like any built-in type, by **registering** them
with the deployment. The engine stays here: dependency ordering, `ref`/`sub`
resolution, apply, rollback, the resource ledger and drift detection are
identical for a custom type. Only the create/update/delete of the resource
itself is delegated, to an HTTP handler the operator runs.

A template author cannot tell the two apart:

```json
{
  "resources": {
    "SupportAgent": { "type": "agent", "properties": { "name": "Support" } },
    "SupportChannel": {
      "type": "channel",
      "properties": {
        "name": "Support WhatsApp",
        "kind": "whatsapp",
        "agent_id": { "ref": "SupportAgent" }
      }
    }
  }
}
```

`SupportChannel` depends on `SupportAgent` through its `ref`, so the agent is
created first and its public id is substituted — exactly as between two built-in
resources.

#### Registering a type

Registration is **deployment configuration, not an API**. There is no route that
adds, changes or redirects a resource type: the handler URL and its signing
secret sit at the same trust level as the database URL, and a registered type
exists uniformly in every project. See [Configuration](#configuration) for the
file's shape and the boot-time checks.

A registration declares:

- **`name`** — the type a template writes. It must be spelled like a built-in
  (`^[a-z][a-z0-9_]*$`) and must not collide with one.
- **`handler`** — where to call, which environment variable holds the signing
  secret, and how long to wait.
- **`capabilities`** — the **optional** operations the handler implements (see
  below). `create`, `update` and `delete` are the lifecycle itself and are always
  required, so they are never listed.
- **`schema`** — a JSON Schema for the resource's `properties`. It is the sole
  allowlist: an undeclared field is rejected with `VALIDATION_FAILED`, naming the
  field, and a missing `required` field fails a create — the same treatment a
  built-in type's schema gets.
- **`write_only_properties`** — the properties whose values must never be stored.
  See [Credentials](#credentials-and-write-only-properties).

#### The handler protocol

One signed `POST` to the registration's URL per operation, with a JSON body:

```json
{
  "request_type": "create",
  "resource_type": "channel",
  "logical_id": "SupportChannel",
  "project_id": "proj_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "properties": { "name": "Support WhatsApp", "kind": "whatsapp" }
}
```

`physical_resource_id` replaces `properties` on `delete`, and accompanies it on
`update` and `read`.

`project_id` is on **every** request type except `validate`, which is not bound
to a deploy. A handler whose resources live in its own database can ignore it
and resolve the project from its own row; one that fronts a system where the
resource actually lives — the case this mechanism exists for — needs it to know
whose resource it is being asked about, and a `physical_resource_id` alone does
not say.

Two headers travel with every call:

| Header | Meaning |
| --- | --- |
| `X-Soat-Signature` | `t=<unix>,v1=<hex hmac-sha256 of "{t}.{body}">`, keyed with the registration's secret — the same scheme [webhooks](./webhooks.md) are signed with. Verify over the **raw** body bytes, and reject a stale `t`. |
| `X-Soat-Idempotency-Key` | Stable per (resource, operation) across re-applies, distinct between resources. A handler that has already completed this key can answer with the same result instead of acting twice. |

What a 2xx must answer with, per operation:

| `request_type` | Response body |
| --- | --- |
| `create` | `{ "physical_resource_id": "…", "outputs": { … } }` — the id is required |
| `update` | the same shape; a **different** `physical_resource_id` means the resource was replaced |
| `delete` | `{}` — and it must be idempotent: deleting an already-gone resource is a 2xx |
| `validate` | `{ "errors": [{ "path": "properties.kind", "message": "…" }] }` — an empty list means valid |
| `read` | `{ "exists": true, "physical_resource_id": "…", "properties": { … }, "outputs": { … } }`, or `{ "exists": false }` |

To refuse deliberately, answer 4xx/5xx with `{ "message": "…" }`; the message is
relayed verbatim on the deploy event, which is the only thing that can explain
*why* the resource was refused. Any non-2xx, unreachable host, timeout, or body
the protocol does not allow fails the deploy with `FORMATION_HANDLER_FAILED` and
enters the ordinary [rollback](#rollback-on-a-failed-deploy) path.

**The engine never retries.** A create that timed out may well have created the
resource, and a blind retry would provision a second one nothing has the id for.
The idempotency key covers the repetition that *is* safe — an operator
re-running a failed deploy.

#### What each optional capability buys

- **`validate`** — a plan-time round trip for the checks a JSON Schema cannot
  express (does this `kind` exist, is this number verified). Without it,
  plan-time validation is the schema alone; everything else is still caught at
  apply time, as a deploy failure rather than a plan error. It runs only on a
  template that already validates locally.
- **`read`** — the live-state read [drift detection](#plan-diff) is built on.
  Without it the type is **exempt from drift detection**: a plan compares
  nothing and reports no changes for it. That is stated in the type's
  registration rather than inferred, so an exempt type is a decision, not a
  silent gap. `read`'s `outputs` are also what a `ref_attr` in the template's
  `outputs` block resolves against; only string-valued entries are addressable.

#### Credentials and write-only properties

A custom type is often the one that carries a credential — a channel's bot token,
an API key for the system behind the handler. It has to be **sent**, or nothing
gets provisioned, but it must not be **stored**: every resource keeps a
`lastAppliedProperties` snapshot so the next deploy can diff against it, and a
token left in there sits at rest in the formation ledger long after the deploy
that used it.

Name those properties in `write_only_properties` and the engine strips them on
the way to storage:

```json
"write_only_properties": ["access_token"]
```

The handler still receives the value in full — stripping is about what is kept,
never about what is sent. Each name must be a property the `schema` declares; a
name it does not know is a boot failure, because a typo would otherwise protect
nothing and the failure mode of that is a credential in the database that nobody
goes looking for.

This is the same guarantee the built-in secret-bearing types have always had (a
`secret` resource drops its `value` the same way) — declared in the registration
rather than coded in a module, because a registered type has no module file to
put it in.

Two consequences worth knowing:

- **A write-only property always looks changed.** With nothing stored to compare
  against, the next deploy sends it again — which is the safe direction for a
  credential (the handler is expected to be idempotent), but it means such a
  resource never reports "no changes".
- **`read` should not return it either.** A handler that echoes a credential back
  in `read.properties` puts it straight back into the drift comparison.

#### Replacement

Some properties cannot be changed in place. When an `update` answers with a
`physical_resource_id` different from the one it was given, the engine treats it
as a replacement: the resource record is re-pointed at the new resource, every
`ref` to it resolves to the new id, and the old resource is then disposed of
under the resource's own `deletion_policy` (`retain` leaves it alive). Cleanup
runs *after* the replacement has succeeded and never fails the deploy — the
desired state is already realised, so a leaked old resource is recorded as a
failed `replace-cleanup` event rather than rolled back.

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `FORMATION_RESOURCE_TYPES_CONFIG` | No | Path to a JSON file registering [custom resource types](#custom-resource-types). Unset (the default) means the built-in types are the whole set. |

```json
{
  "resource_types": [
    {
      "name": "channel",
      "description": "A messaging channel connecting an agent to a transport.",
      "handler": {
        "url": "https://platform.internal/v1/formation-resources",
        "secret_env": "CHANNEL_HANDLER_SECRET",
        "timeout_seconds": 30
      },
      "capabilities": ["validate", "read"],
      "write_only_properties": ["access_token"],
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "kind": { "type": "string" },
          "agent_id": { "type": "string" },
          "access_token": { "type": "string" }
        },
        "required": ["name", "kind"]
      }
    }
  ]
}
```

The secret is referenced by variable **name**, never inlined, so the file itself
carries nothing confidential and can be baked into an image or a config map.

The file is read **once, at boot**. Changing it takes effect on the next
restart; a deploy uses the set that was loaded when the process started, so a
single apply can never straddle two registration sets.

Every problem with the file is a **hard boot failure**, naming the file and the
offending entry — a name that collides with a built-in or repeats within the
file, a handler URL that is not `http(s)`, a `secret_env` naming a variable that
is unset or empty, a non-positive timeout, an unknown capability, a
`write_only_properties` entry the schema does not declare, or a `schema`
that is not an object schema. A half-valid registration would otherwise publish
a resource type whose every apply fails, or — for the missing secret — sign
every request with an empty key.

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
