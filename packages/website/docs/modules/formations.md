---
description: "A CloudFormation-inspired declarative layer that provisions an entire AI agent stack from a single JSON or YAML template."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Formations

A CloudFormation-inspired declarative deployment layer that provisions an entire AI agent stack from a single JSON/YAML template.

> **Note:** Creating a formation also creates underlying resources (agents, memories, etc.). The calling identity must also have the relevant `agents:CreateAgent`, `memories:CreateMemory`, etc. permissions.

## Overview

One template replaces the separate API calls that create an AI provider, memory, agent tool, and agent:

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

`MyAgent`'s `ref` expressions make `MyProvider` and `MyMemory` dependencies: they are created first and the agent receives their physical IDs. A 14-resource stack in one call: [Deploy a Multi-Agent App with Agent Formation — Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Deploy a Multi-Agent App with Agent Formation - Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template)
- [Deploy a Multi-Agent App with Agent Formation - Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation)
- [Deploy a Multi-Agent App with Agent Formation - Step 10 (Update the formation)](/docs/tutorials/formations#step-10--update-the-formation)
- [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — agents plus their coordinating orchestration as one stack

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

One record per deploy (create, update, delete); [`GET /api/v1/formations/{formation_id}/events`](/docs/api/formations/list-formation-events) returns the full history.

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

A template has four top-level keys. Complete 14-resource template: [Deploy a Multi-Agent App with Agent Formation — Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template).

| Key          | Required | Description                                                  |
| ------------ | -------- | ------------------------------------------------------------ |
| `parameters` | No       | Map of parameter names → parameter declarations              |
| `resources`  | Yes      | Map of logical resource ID → resource declaration            |
| `outputs`    | No       | Map of output names → values (may contain `ref` expressions) |
| `metadata`   | No       | Arbitrary metadata; supports `sub`/`param`/`ref` substitution (see [Metadata Substitution](#metadata-substitution)) |

#### Key Naming and Case

The template is stored and returned **verbatim**; keys are never rewritten.

- **Resource `properties` keys** are **snake_case**, matching the REST API body fields (`default_model`, `ai_provider_id`). A camelCase key is rejected at validation as an unknown field.
- **Declared allowed values are checked at validation**: `validate-formation` and `plan-formation` refuse `"provider": "openia"` before anything is created. Accepted values: [Formations Types](/docs/formations-types).
- **Logical IDs, parameter names, and output names** are preserved exactly, in any case. A `--parameter` override (or a key in the request's top-level `parameters` bag) must match the declared name exactly (`--parameter aiProviderName=…` matches `aiProviderName`, not `ai_provider_name`).

### Parameters

Parameters inject deploy-time values without changing the template:

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

Usable anywhere in `properties` or `outputs`:

| Expression                       | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| `{ "param": "ParamName" }`       | Replaced with the parameter's value as-is                                |
| `{ "sub": "text ${ParamName}" }` | String interpolation — embeds the parameter value inside a larger string |

A `${Name}` token inside a `sub` may also name a resource logical ID — see [Sub Expressions](#sub-expressions).

#### Providing Parameter Values

Pass values in the `parameters` field of the validate, plan, create, or update request:

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

- Values override any `default`; parameters with a `default` are optional.
- A parameter with no `default` and no value fails with `400 Missing required parameters`, unless declared `use_previous_value: true` (see [Reusing Previously Stored Values](#reusing-previously-stored-values)).
- Values are **never stored**: supply them on every create/update, except `use_previous_value` parameters on update.
- On `validate-formation`, `parameters` is optional: omitted, only the template's structure is checked; provided (even as `{}`), each missing required parameter is an entry in `errors`.

#### Providing Parameter Values via the CLI

The CLI takes a repeatable `--parameter` instead of a JSON `--parameters` object, plus `--env-file` to load an `.env` file.

| Syntax | Example | When to use |
|---|---|---|
| `Key=literal` | `--parameter AppUrl=https://example.com` | Non-sensitive, static values |
| `Key=$VAR` or `Key=${VAR}` | `--parameter ApiKey=$API_KEY` | Variable already exported in the shell |
| `Key=@VAR_NAME` | `--parameter ApiKey=@API_KEY` | Variable in `--env-file`; shell-safe (no expansion) |
| `KEY` (no `=`) | `--parameter API_KEY` | Read env var by exact name from `--env-file` or shell env |

The shell expands `$VAR` before the CLI starts, so `--env-file` values need `@VAR_NAME` or the bare key. Lookup order: `--env-file`, then `process.env`. An unset `@VAR_NAME` / bare-`KEY` variable is **omitted** from the request (the server reuses the stored value for `use_previous_value: true` parameters or returns `400 Missing required parameters`); an unset `Key=$VAR` / `Key=${VAR}` fails fast in the CLI.

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

`use_previous_value: true` lets an **update** reuse a parameter's stored value instead of re-supplying it (AWS CloudFormation's `UsePreviousValue`, declared in the template), so a pipeline can update part of a formation without holding every secret:

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

- A supplied value **always overrides** it, so rotation works by passing the parameter.
- It satisfies the required-parameter check **on update only**; on create an omitted parameter still returns `400 Missing required parameters`, as does a parameter **without** `use_previous_value` that is neither supplied nor defaulted.
- The value is reused only where the resource retains it: a `secret` resource's encrypted value is preserved untouched (its plaintext is never stored); other resources reuse the **last-applied** value of the field; never-stored fields are dropped.

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

- **`type`** — a built-in type (`ai_provider`, `tool`, `agent`, `actor`, `api_key`, `chat`, `conversation`, `dataset`, `dataset_item`, `document`, `file`, `guardrail`, `ingestion_rule`, `memory`, `memory_entry`, `model_route`, `eval`, `orchestration`, `policy`, `project_price`, `quota`, `secret`, `session`, `webhook`, `trigger`, `workflow`) or a [custom resource type](#custom-resource-types) the deployment registered. Properties reference for the built-in ones: [Formations Types](/docs/formations-types).
- **`properties`** — resource-specific properties (snake_case, matching the REST API body fields)
- **`depends_on`** — explicit dependencies in addition to implicit `ref` dependencies
- **`deletion_policy`** — what happens to the physical resource when it is removed from the stack: `delete` (default) deletes it; `retain` keeps it alive and only removes the formation record
- **`metadata`** — arbitrary key/value stored on the resource record

### Ref Expressions

`{ "ref": "LogicalId" }` anywhere in `properties` or `outputs` substitutes another resource's physical public ID once it is created:

```json
"ai_provider_id": { "ref": "MyProvider" }
```

Refs are implicit dependencies; `depends_on` need not repeat them.

### Sub Expressions

`{ "sub": "..." }` interpolates values **inside** a string. A `${Name}` token resolves to:

- the parameter's value, when `Name` is declared in `parameters`;
- the **physical public ID** of another resource, when `Name` is a resource logical ID (resolved at apply time, like a `ref`);
- itself (left literal), when `Name` starts with `body.`: those are [tool-argument interpolations](./tools.md#http) resolved at tool-call time.

Resource logical IDs inside subs are implicit dependencies, like `ref`.

Main use: a [secret reference](./secrets.md#secret-references-secret) to a secret in the same template. The logical ID resolves to the `sec_...` physical ID, storing a `{{secret:sec_...}}` token the tool resolves at call time:

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

The stored header is `Bearer {{secret:sec_01HXYZ}}`; the decrypted value is substituted server-side at call time and never echoed by any API response.

### Secrets in Templates

`formations:GetFormation` is a wider audience than `secrets:GetSecret` or `triggers:GetTriggerSecret`, so credential material never reaches a formation read.

**A declared credential is masked on every read.** A `secret` resource's `value`, and any property a [custom resource type](#custom-resource-types) declares `write_only`, reads back as `{ "no_echo": true }` in the stored `template` and in a `plan-formation` diff, and is dropped from the `lastAppliedProperties` snapshot the planner diffs against:

```json
{
  "resources": {
    "ApiSecret": {
      "type": "secret",
      "properties": { "name": "third-party-api-key", "value": { "no_echo": true } }
    }
  }
}
```

The placeholder is an object so that a read-edit-write round trip sending it back fails the schema's `type: string` check with a `400` instead of rotating the secret.

The stored template keeps the value it was given (an update with no new template re-applies the stored one). Declare the value through a `no_echo` parameter to keep it out of the database as well:

```yaml
parameters:
  ApiKey: { type: string, no_echo: true, use_previous_value: true }
resources:
  ApiSecret:
    type: secret
    properties: { name: third-party-api-key, value: { param: ApiKey } }
```

`no_echo` masks the value in `resolved_parameters`; `use_previous_value` lets a later deploy omit it and reuse the stored encrypted secret.

**A generated signing secret is not an output.** A `trigger` or `webhook` resource's `secret` cannot be named by a `ref_attr` output:

```json
"outputs": { "hookSecret": { "ref_attr": "MyWebhook.secret" } }
```

Validation, `plan-formation`, `create-formation` and `update-formation` answer `400 VALIDATION_FAILED` naming the attribute. Read it from its permission-gated route: [`GET /api/v1/webhooks/{webhook_id}/secret`](/docs/api/webhooks/get-webhook-secret) or [`GET /api/v1/triggers/{trigger_id}/secret`](/docs/api/triggers/get-trigger-secret).

Formations deployed before this refusal wrote the plaintext secret into `outputs`; it is dropped from every API response but the row still holds it. Clear the rows once, then **rotate every trigger and webhook secret a formation published**:

```bash
PURGE_DRY_RUN=1 pnpm --filter @soat/server purge-formation-secret-outputs
pnpm --filter @soat/server purge-formation-secret-outputs
```

The sweep is idempotent; it derives what to clear from each stored template, not a marker.

### Metadata Substitution

The template's top-level `metadata` block is a substitution site like `outputs`: `{ "ref": "logicalId" }`, `{ "param": "Name" }`, and `{ "sub": "text ${Name}" }` resolve at deploy time. Raw expressions stay in `template.metadata` (re-resolved on re-deploy); resolved values are on `resolved_metadata`; the parameter values used are on `resolved_parameters`, `no_echo: true` values masked (`***`).

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
The formation-level `metadata` field supplied alongside `template` on `create-formation` / `update-formation` is a **static** annotation bag, never resolved. `sub`/`param`/`ref` expressions there are rejected with `400 FORMATION_INVALID_METADATA`.
:::

### Topological Ordering

The dependency graph is built from explicit `depends_on` entries, implicit `ref` expressions, and resource logical IDs inside `sub` strings, then topologically sorted (Kahn's algorithm) for creation order. A cycle fails validation.

### Resource Lifecycle

| Status    | Meaning                                     |
| --------- | ------------------------------------------- |
| `pending` | Not yet provisioned                         |
| `created` | Successfully created by a formation deploy  |
| `updated` | Successfully updated by a subsequent deploy |
| `deleted` | Deleted when removed from the template, or rolled back after a failed deploy |
| `failed`  | Last operation failed                       |

A **replaced** resource (see [Custom Resource Types](#custom-resource-types)) stays `updated`, with `physical_resource_id` re-pointed at the replacement. The deploy records a `replace` event and, after every other change in the operation, a `replace-cleanup` event for the disposal of the old resource (`replace-retained` when `deletion_policy` is `retain`).

A `deleted` resource is an audit tombstone: `get-formation` still lists it; `plan-formation` (as a `delete` action) and `update-formation` report it once, at the deploy that removes it from the template; a later no-op reconcile never re-lists it.

### A Failed Deploy Still Answers 2xx

A deploy is a reconciler, so the two failure kinds are reported differently:

| What went wrong | How it is reported |
| --- | --- |
| The template's **shape** — an unknown field, a missing required property, a bad `ref` | `400 VALIDATION_FAILED`, nothing is deployed |
| The **reconciliation** — a resource the platform refused to create or update | `201`/`200` with `status: "failed"` and a populated `error` |

**`2xx` means the deploy was attempted, not that it worked**; read `status`, then `error`:

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

`error` stays on `get-formation` while the stack is `failed`; the next successful deploy clears it. `list-formation-events` keeps every operation with the same `error` bag.

**The CLI exits non-zero on that body.** `create-formation` and `update-formation` print the payload to stdout (`$(…)` capture and `| jq` unaffected), write the reason to stderr and exit `1`:

```bash
soat update-formation --formation-id "$F" --template "$T" && echo "deployed"
# update-formation: the deploy failed at resource 'case1' — the formation is
# 'failed'. VALIDATION_FAILED: dataset_id is immutable: …
# (exit 1 — "deployed" is not printed)
```

`get-formation` on a `failed` stack exits `0`; so do `plan-formation` / `validate-formation`, whose outcome is their payload.

### Rollback on a Failed Deploy

A deploy stops at the first failing resource and walks back every resource it **created** in that deploy, in reverse dependency order (a dependency after its dependents). The stack ends `failed` with nothing new standing, so a corrected re-deploy re-creates those resources from scratch.

Left alone:

- An **updated** resource keeps its new state (no pre-update snapshot is taken).
- A `deletion_policy: retain` resource survives; its record keeps pointing at it, so the next deploy adopts it rather than provisioning a duplicate.

Each unwind is an entry in the operation's `events` after the triggering failure: `rollback` (`succeeded` or `failed`) for a walked-back resource, `rollback-skipped` for a retained one. A failed `rollback` is reported, never thrown; the original error stays in the operation's `error`, and the record keeps pointing at the physical resource for manual cleanup.

Stack statuses:

| Status          | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| `creating`      | First deployment in progress                             |
| `active`        | All resources provisioned successfully                   |
| `updating`      | A template update is in progress                         |
| `failed`        | Last deployment ended with one or more resource failures |
| `deleting`      | Stack teardown in progress                               |
| `deleted`       | All resources removed                                    |
| `delete_failed` | Stack teardown encountered failures                      |

Deletion is idempotent: a managed resource already removed outside the formation counts as gone. A teardown that cannot finish answers `409 FORMATION_DELETE_FAILED`, naming every blocker in `error.meta.failures` as `{ logical_id, resource_type, error }`.

**A predictable blocker is caught before anything is deleted.** Teardown pre-flights the resources it is about to remove; a foreseeable refusal destroys nothing, the stack stays `active`, and the same `delete-formation` succeeds once the blocker is resolved. The one such blocker today is an **agent with generation or trace history**, which the platform never force-deletes on its own ([`DELETE /api/v1/agents/{agent_id}?force=true`](/docs/api/agents/delete-agent) is an operator decision). Declare the agent with `deletion_policy: retain` to leave it standing; a retained resource is never deleted, so never blocks. An eval run is one generation per dataset item, so an agent shipped with the eval that verifies it has history the moment the suite runs; see [Gate a Canary Promotion on an Eval](../tutorials/gate-a-canary-promotion-on-an-eval.md).

An **unforeseeable** error surfaces mid-teardown: resources removed before it stay removed (teardown does not roll back), the stack is left `delete_failed`, and the error message says which case applies. Resolve the blockers and delete again.

### Plan Diff

Each entry in `plan-formation`'s `changes[]` carries a `diff` object alongside `logical_id`, `resource_type`, `action`, and `physical_resource_id`:

| Field           | Type          | Description                                                                          |
| --------------- | ------------- | ------------------------------------------------------------------------------------- |
| `diff.desired`  | object        | Resolved desired-state properties, after parameter and `ref`/`sub` substitution — credential-bearing properties read as `{ "no_echo": true }`, see [Secrets in Templates](#secrets-in-templates) |
| `diff.current`  | object \| null | Current properties being compared against — `null` when there is nothing to compare (a `create`, an unregistered resource type, or a failed read) |

For a type whose live state can be read back (most), `diff.current` is the resource as it exists today; for a write-only type (currently only `secret`), it is the last-applied snapshot on the formation resource, which `update-formation` also diffs against.

Plan and apply share one change rule:

- Only properties **the template declares** are compared; a field the resource carries but the template omits is not a change.
- Comparison is **structural**; key order in a nested value bag is not a change.
- A property resolving to `undefined` (a kept `use_previous_value` parameter) reuses the previous value, or is dropped when there is none.

### A Formation Only Does What the Caller Could Do Directly

A formation is authorized twice: for the request (`formations:CreateFormation`, `formations:UpdateFormation`, `formations:DeleteFormation`, `formations:PlanFormation`) and **once per declared resource**, as the action a direct call would need: declaring a guardrail needs `guardrails:CreateGuardrail`, removing one needs `guardrails:DeleteGuardrail`. A `Deny` on a resource action applies to the formation path as to the route.

The check runs over the whole template **before anything is applied**: no formation is created, and a refused update or teardown leaves the stack `active`. The `403` names every missing action at once:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Not permitted to apply 1 resource(s) this template declares: MyGuardrail (guardrails:CreateGuardrail). A formation may only do what the caller could do directly.",
    "meta": {
      "denied_actions": [
        {
          "logical_id": "MyGuardrail",
          "resource_type": "guardrail",
          "action": "guardrails:CreateGuardrail"
        }
      ]
    }
  }
}
```

[`POST /api/v1/formations/plan`](/docs/api/formations/plan-formation) changes nothing, so it **reports** the same list under `unauthorized_actions` instead of refusing; the field is absent when the caller may perform every action the plan implies.

- A `policy` resource needs the `admin` role rather than an action, as the policies routes do.
- An `api_key` resource is minted **under the deploying caller**, as [`POST /api/v1/api-keys`](/docs/api/api-keys/create-api-key) mints under the requesting user; the owner's permissions are its ceiling, so declaring one needs only `api-keys:CreateApiKey`.
- A `trigger` resource's `created_by` is the [run-as identity](./triggers.md#run-as-identity) a firing mints a token for: the deploying caller, so a firing never exceeds who declared it.
- A [custom resource type](#custom-resource-types) has no SOAT action, so it is gated on the request's `formations:*` action alone.

### Ids a Template Names Are Resolved Within Its Own Project

A property naming an existing resource by id (an `ai_provider`'s `secret_id`, a `session`'s `agent_id`, an `ingestion_rule`'s `tool_id`) resolves only within the deployment project. Another project's id fails the apply as though it did not exist, so the lookup cannot probe other projects.

### Custom Resource Types

A deployment can **register** resource types SOAT knows nothing about (a messaging channel, a routing rule) and declare them like any built-in type. Dependency ordering, `ref`/`sub` resolution, apply, rollback, the resource ledger and drift detection are identical; only create/update/delete is delegated to an HTTP handler the operator runs.

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

`SupportChannel`'s `ref` makes `SupportAgent` a dependency: created first, public id substituted, as between two built-in resources.

#### Registering a type

Registration is **deployment configuration, not an API**: the handler URL and signing secret sit at the trust level of the database URL, and a registered type exists in every project. File shape and boot-time checks: [Configuration](#configuration).

A registration declares:

- **`name`** — the type a template writes; `^[a-z][a-z0-9_]*$`, no collision with a built-in.
- **`handler`** — URL, the environment variable holding the signing secret, and the timeout.
- **`capabilities`** — the **optional** operations the handler implements (below). `create`, `update` and `delete` are always required and never listed.
- **`schema`** — JSON Schema for `properties`; the sole allowlist. An undeclared field is `VALIDATION_FAILED` naming the field; a missing `required` field fails a create.
- **`write_only_properties`** — properties whose values are never stored. See [Credentials](#credentials-and-write-only-properties).

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

`physical_resource_id` replaces `properties` on `delete` and accompanies it on `update` and `read`. `project_id` is on **every** request type except `validate`, which is not bound to a deploy.

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

To refuse, answer 4xx/5xx with `{ "message": "…" }`; the message is relayed verbatim on the deploy event. Any non-2xx, unreachable host, timeout, or body outside the protocol fails the deploy with `FORMATION_HANDLER_FAILED` and enters the ordinary [rollback](#rollback-on-a-failed-deploy) path.

**The engine never retries**: a timed-out create may have created the resource, and a blind retry would provision a second one nothing has the id for. The idempotency key covers an operator re-running a failed deploy.

#### What each optional capability buys

- **`validate`** — a plan-time round trip for checks a JSON Schema cannot express (does this `kind` exist). Without it, plan-time validation is the schema alone and everything else is an apply-time deploy failure. Runs only on a template that already validates locally.
- **`read`** — the live-state read [drift detection](#plan-diff) uses. Without it the type is **exempt from drift detection**: a plan reports no changes for it. `read`'s `outputs` are also what a `ref_attr` in the template's `outputs` resolves against; only string-valued entries are addressable.

#### Credentials and write-only properties

A credential (a channel's bot token) must be **sent** but not **stored** in the `lastAppliedProperties` snapshot every resource keeps for the next diff. Name such properties in `write_only_properties` and the engine strips them on the way to storage:

```json
"write_only_properties": ["access_token"]
```

The same list masks the property on every read of a stored template and in a plan diff (see [Secrets in Templates](#secrets-in-templates)); the handler still receives the full value. Each name must be a property the `schema` declares; an unknown name (a typo would protect nothing) is a boot failure. A built-in `secret` resource drops its `value` the same way.

Consequences:

- **A write-only property always looks changed**: with nothing stored to compare against, every deploy sends it again (the handler is expected to be idempotent), so the resource never reports "no changes".
- **`read` should not return it either**: a credential echoed in `read.properties` goes straight back into the drift comparison.

#### Replacement

When an `update` answers with a different `physical_resource_id`, the resource record is re-pointed at it, every `ref` resolves to the new id, and the old resource is disposed of under the resource's `deletion_policy` (`retain` leaves it alive).

Cleanup is **deferred to the end of the operation**, after every other change and orphan removal, so dependents are re-pointed by then and a type whose delete refuses while referenced (an `ai_provider` answers `409` while an agent, chat or model route names it; `force` does not override that) is deletable when the disposal runs.

A disposal that still fails never fails the deploy (the desired state is realised). It is reported twice and retried:

- a failed `replace-cleanup` event on the operation, and
- `error.code: "FORMATION_REPLACE_CLEANUP_FAILED"` on the formation itself while the resource is still live, with `error.meta.failures` naming each `{ logical_id, resource_type, physical_resource_id, error }`. The formation stays `active` and the operation stays `succeeded`.

The un-deleted id stays on the record as pending cleanup; the next deploy and the teardown retry it and clear the error once it succeeds. A pending cleanup failing during teardown is recorded but never leaves the formation `delete_failed`.

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

The secret is referenced by variable **name**, never inlined, so the file carries nothing confidential. It is read **once, at boot**; changes take effect on the next restart.

Every problem with the file is a **hard boot failure** naming the file and the offending entry: a name that collides with a built-in or repeats within the file, a handler URL that is not `http(s)`, a `secret_env` naming a variable that is unset or empty, a non-positive timeout, an unknown capability, a `write_only_properties` entry the schema does not declare, or a `schema` that is not an object schema.

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

An [orchestration](./orchestrations.md) is itself a formation resource type, so a team of agents plus the flow that coordinates them deploys as one stack; see the [Agent Squad example](./orchestrations.md#agent-squad) and the [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) tutorial.
