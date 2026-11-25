---
description: 'A CloudFormation-inspired declarative layer that provisions an entire AI agent stack from a single JSON or YAML template.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Formations

A CloudFormation-inspired declarative deployment layer that provisions an entire AI agent stack from a single JSON/YAML template.

> **Note:** Creating a formation also creates underlying resources (agents, memory stores, etc.). The calling identity must also have the relevant `agents:CreateAgent`, `memories:CreateMemoryStore`, etc. permissions.

## Overview

One template replaces the separate API calls that create an AI provider, memory store, agent tool, and agent:

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
    "MyMemoryStore": {
      "type": "memory_store",
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
          "memory_store_ids": [{ "ref": "MyMemoryStore" }]
        }
      }
    }
  },
  "outputs": {
    "agentId": { "ref": "MyAgent" }
  }
}
```

`MyAgent`'s `ref` expressions make `MyProvider` and `MyMemoryStore` dependencies: they are created first and the agent receives their physical IDs. A 14-resource stack in one call: [Deploy a Multi-Agent App with Agent Formation — Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Deploy a Multi-Agent App with Agent Formation - Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template)
- [Deploy a Multi-Agent App with Agent Formation - Step 6 (Deploy the formation)](/docs/tutorials/formations#step-6--deploy-the-formation)
- [Deploy a Multi-Agent App with Agent Formation - Step 10 (Update the formation)](/docs/tutorials/formations#step-10--update-the-formation)
- [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — agents plus their coordinating orchestration as one stack

## Data Model

### Formation

| Field                 | Type   | Description                                                                                                                                                                                                                      |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | string | Public ID (`form_` prefix)                                                                                                                                                                                                       |
| `project_id`          | string | Project public ID                                                                                                                                                                                                                |
| `name`                | string | Formation name (unique per project)                                                                                                                                                                                              |
| `template`            | object | The last applied template (raw — substitution expressions preserved)                                                                                                                                                             |
| `outputs`             | object | Resolved output values                                                                                                                                                                                                           |
| `status`              | string | `creating` \| `active` \| `updating` \| `failed` \| `deleting` \| `deleted` \| `delete_failed`                                                                                                                                   |
| `metadata`            | object | Static annotations stored on the record (supplied at create/update), per [Tags and metadata](iam.md#tags-and-metadata). Not a substitution site — `sub`/`param`/`ref` expressions are rejected (use `template.metadata` instead) |
| `resolved_metadata`   | object | The template's top-level `metadata` after `sub`/`param`/`ref` substitution at the last deploy (null when the template declares no metadata)                                                                                      |
| `resolved_parameters` | object | Parameter values applied at the last deploy, for auditability (`no_echo` values masked as `***`; null when the template declares no parameters)                                                                                  |
| `error`               | object | Why the formation is `failed` / `delete_failed`, as `{ code, message, meta }` — the same shape an error response uses. Null in every other status, and cleared by the next successful deploy                                     |
| `resources`           | array  | Resources managed by the formation                                                                                                                                                                                               |
| `created_at`          | string | ISO 8601 creation timestamp                                                                                                                                                                                                      |
| `updated_at`          | string | ISO 8601 last-updated timestamp                                                                                                                                                                                                  |

### FormationResource

| Field                  | Type   | Description                                                  |
| ---------------------- | ------ | ------------------------------------------------------------ |
| `id`                   | string | Public ID (`form_res_` prefix)                               |
| `logical_id`           | string | Logical ID from the template                                 |
| `resource_type`        | string | Resource type (`agent`, `tool`, `memory_store`, etc.)        |
| `physical_resource_id` | string | Public ID of the physical SOAT resource                      |
| `status`               | string | `pending` \| `created` \| `updated` \| `deleted` \| `failed` |

### FormationOperation

One record per deploy (create, update, delete); [`GET /api/v1/formations/{formation_id}/events`](/docs/api/formations/list-formation-events) returns the full history.

| Field            | Type   | Description                                                                                                                                          |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string | Public ID (`form_op_` prefix)                                                                                                                        |
| `operation_type` | string | `create` \| `update` \| `delete`                                                                                                                     |
| `status`         | string | `queued` \| `running` \| `completed` \| `failed`                                                                                                     |
| `plan`           | object | Planned changes computed before execution                                                                                                            |
| `events`         | array  | Per-resource event log with timestamp, action, status; a `failed` event carries its `error` as `{ code, message, meta? }`                            |
| `error`          | object | Why this operation failed, as `{ code, message, meta }` — the same bag the formation carries while that failure is its current state. Null otherwise |
| `created_at`     | string | ISO 8601 creation timestamp                                                                                                                          |
| `updated_at`     | string | ISO 8601 last-updated timestamp                                                                                                                      |

## Key Concepts

### Formation Template

A template has four top-level keys. Complete 14-resource template: [Deploy a Multi-Agent App with Agent Formation — Step 3 (Write the formation template)](/docs/tutorials/formations#step-3--write-the-formation-template).

| Key          | Required | Description                                                                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `parameters` | No       | Map of parameter names → parameter declarations                                                                                          |
| `resources`  | Yes      | Map of logical resource ID → resource declaration                                                                                        |
| `outputs`    | No       | Map of output names → values; each value is a string or one `ref`, `param`, `sub` or `ref_attr` expression, else `400 VALIDATION_FAILED` |
| `metadata`   | No       | Arbitrary metadata; supports `sub`/`param`/`ref` substitution (see [Metadata Substitution](#metadata-substitution))                      |

A request carrying a template may be up to 10 MB, so documents can be declared with their content inline; every other route keeps a 1 MB body limit.

A `template` sent as a string is parsed as YAML (JSON is a subset). One that does not parse — a duplicated key, a bad indent — is a single error at path `""` reading `Template is not valid YAML or JSON: <parser message>`.

#### Key Naming and Case

The template is stored and returned **verbatim**; keys are never rewritten.

- **Resource `properties` keys** are **snake_case**, matching the REST API body fields (`default_model`, `ai_provider_id`). A top-level key authored in camelCase is read as the snake_case field it spells; one that spells no field is rejected at validation as an unknown field.
- **Unknown keys are rejected at every depth the resource's fields are declared**, reported by their dotted path (`knowledge_config.extraction`, `execute.bogus_key`, `stop_conditions.0.tool`) — the same field list the resource's own REST route enforces. Below the top level nothing is re-spelled, so a nested camelCase key is unknown. A free-form bag — `metadata`, a JSON Schema, a JSON Logic body, `preset_parameters` — is carried as a value and never read.
- **A missing `required` field is rejected at the same depths**, by its dotted path (`reasoning.effort`): a nested object is checked whole, on update too.
- **A value outside its field's `enum` is rejected at the same depths**, by its dotted path (`reasoning.effort`, `execute.auth.type`), at validation rather than mid-deploy. A `ref`, `param` or `sub` in its place resolves at deploy and is not checked.
- **Declared allowed values are checked at validation**: `validate-formation` and `plan-formation` refuse `"provider": "openia"` before anything is created. Accepted values: [Formations Types](/docs/formations-types).
- **A value built with an expression is checked once it resolves.** A property holding a `ref`, `param` or `sub` at any depth (a policy `resource: [{ "sub": "srn:${ProjectId}:tool:*" }]`) passes validation and plan on its resource-specific rules; the deploy checks the resolved value and fails the resource when it is invalid. A literal value is checked at validation. A credential slot is the exception: a `param` or `sub` there is refused at validation ([Secrets in Templates](#secrets-in-templates)).
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
    "ApiKeySecret": {
      "type": "secret",
      "properties": { "name": "my-api-key", "value": { "param": "ApiKey" } }
    },
    "MyTool": {
      "type": "tool",
      "properties": {
        "name": "my-tool",
        "execute": {
          "url": { "sub": "${AppUrl}/api/endpoint" },
          "headers": {
            "Authorization": { "sub": "Bearer {{secret:${ApiKeySecret}}}" }
          }
        }
      }
    }
  }
}
```

#### Parameter Declaration Fields

| Field                | Required | Description                                                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `type`               | No       | `string` (when omitted), `number` or `list` — see [Parameter Types](#parameter-types)                               |
| `default`            | No       | Default value used when the parameter is not provided at deploy time, of the declared `type`                        |
| `description`        | No       | Human-readable description of the parameter's purpose                                                               |
| `no_echo`            | No       | When `true`, signals that the value is sensitive and should not be logged or displayed                              |
| `use_previous_value` | No       | When `true`, omitting the parameter **on update** reuses its previously stored value instead of failing as required |

#### Parameter Types

A deploy-time value is always a string; it takes the parameter's declared `type`, so a `{ "param": … }` expression resolves to a typed value:

| `type`   | Supplied value                 | Resolves to  | `default`                    |
| -------- | ------------------------------ | ------------ | ---------------------------- |
| `string` | any string                     | the string   | a string                     |
| `number` | a numeric string, `"5"`        | `5`          | a number, or its string form |
| `list`   | a JSON array, `"[\"infra/\"]"` | `["infra/"]` | an array, or its JSON string |

- A value that does not parse as its type is refused with `400 FORMATION_INVALID_PARAMETERS` on plan, create and update, and is an entry in `errors` on validate; `meta.details` names each parameter.
- An unknown `type`, or a `default` that does not parse as its `type`, fails template validation.
- A `{ "sub": … }` embeds a `number` or `list` as its JSON text; `resolved_parameters` records it the same way.
- A JSON Logic guard reads the typed value: `{ "in": [{ "var": "task.payload.path" }, { "param": "Paths" }] }` tests list membership, and `{ "<": [{ "var": "task.payload.rounds" }, { "param": "LimitN" }] }` compares numbers.

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
- Values are **never stored**: supply them on every plan, create and update, except `use_previous_value` parameters on update and on a plan with `formation_id`. A plan answers `400 FORMATION_MISSING_PARAMETERS` where its deploy would.
- An update without `template` redeploys the stored template under the same checks: a missing or unparseable value is `400` before anything deploys.
- On `validate-formation`, `parameters` is optional: omitted, only the template's structure is checked; provided (even as `{}`), each missing required parameter is an entry in `errors`.

#### Providing Parameter Values via the CLI

The CLI takes a repeatable `--parameter` instead of a JSON `--parameters` object, plus `--env-file` to load an `.env` file.

| Syntax                     | Example                                  | When to use                                               |
| -------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `Key=literal`              | `--parameter AppUrl=https://example.com` | Non-sensitive, static values                              |
| `Key=$VAR` or `Key=${VAR}` | `--parameter ApiKey=$API_KEY`            | Variable already exported in the shell                    |
| `Key=@VAR_NAME`            | `--parameter ApiKey=@API_KEY`            | Variable in `--env-file`; shell-safe (no expansion)       |
| `KEY` (no `=`)             | `--parameter API_KEY`                    | Read env var by exact name from `--env-file` or shell env |

The shell expands `$VAR` before the CLI starts, so `--env-file` values need `@VAR_NAME` or the bare key. Lookup order: `--env-file`, then `process.env`. An unset `@VAR_NAME` / bare-`KEY` variable is **omitted** from the request (the server reuses the stored value for `use_previous_value: true` parameters or returns `400 Missing required parameters`); an unset `Key=$VAR` / `Key=${VAR}` fails fast in the CLI.

{/* single-client: CLI parameter parsing */}

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

- **`type`** — a built-in type (`ai_provider`, `tool`, `agent`, `actor`, `api_key`, `chat`, `conversation`, `dataset`, `dataset_item`, `decider`, `document`, `file`, `guardrail`, `ingestion_rule`, `memory_store`, `memory`, `model_route`, `eval`, `oauth_client`, `orchestration`, `playbook`, `policy`, `project_price`, `quota`, `secret`, `session`, `webhook`, `trigger`, `workflow`) or a [custom resource type](#custom-resource-types) the deployment registered. Properties reference for the built-in ones: [Formations Types](/docs/formations-types).
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

A pipeline tool's step `tool_id` may be a ref; `validate-formation` checks that pipeline exactly as one with a literal id, including the warning for a declared `parameters` property no step `input` (nor `output`) reads.

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
      "properties": {
        "name": "third-party-api-key",
        "value": { "no_echo": true }
      }
    }
  }
}
```

A template read back can be deployed again as read. On [`PUT /api/v1/formations/{formation_id}`](/docs/api/formations/update-formation), and on [`POST /api/v1/formations/plan`](/docs/api/formations/plan-formation) with `formation_id`, each placeholder takes the stored value at the same path, provided its resource then equals the declaration last deployed; a resource changed beside a placeholder, a placeholder in a resource the formation does not hold, and any placeholder on a create are `400 VALIDATION_FAILED` with the resource's path in `meta.details`. A credential is kept where it stands or replaced by sending the value, never carried into a changed resource.

A `tool` resource follows [Credentials Are References, Never Literals](./tools.md#credentials-are-references-never-literals): `validate-formation` reports a literal credential at its path, and the header references a `secret` resource instead (`{ "sub": "Bearer {{secret:${ApiSecret}}}" }`). A literal a stored tool or agent holds is masked in the stored `template` and on both sides of a `plan-formation` diff.

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

A stored `outputs` row may still hold a plaintext secret, dropped from every API response but present on the row. Clear the rows once, then **rotate every trigger and webhook secret a formation published**:

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
  MyMemoryStore: { type: memory_store, properties: { name: shared } }
metadata:
  my_version: { sub: '${my_version}' }
  memory_store: { ref: MyMemoryStore }
```

Deploying with `--parameter my_version=1.2.3` yields `resolved_metadata` of `{ "my_version": "1.2.3", "memory_store": "mstore_01HXYZ" }`, while `template.metadata.my_version` remains `{ "sub": "${my_version}" }`.

:::warning[The template `metadata` block is the only metadata substitution site]
The formation-level `metadata` field supplied alongside `template` on `create-formation` / `update-formation` is a **static** annotation bag, never resolved. `sub`/`param`/`ref` expressions there are rejected with `400 FORMATION_INVALID_METADATA`.
:::

### Topological Ordering

The dependency graph is built from explicit `depends_on` entries, implicit `ref` expressions, and resource logical IDs inside `sub` strings, then sorted so each resource is created after what it depends on, in declaration order among independent ones. A cycle fails validation with an error naming the resources in it.

### Resource Lifecycle

| Status    | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `pending` | Not yet provisioned                                                          |
| `created` | Successfully created by a formation deploy                                   |
| `updated` | Successfully updated by a subsequent deploy                                  |
| `deleted` | Deleted when removed from the template, or rolled back after a failed deploy |
| `failed`  | Last operation failed                                                        |

A **replaced** resource (see [Custom Resource Types](#custom-resource-types)) stays `updated`, with `physical_resource_id` re-pointed at the replacement. The deploy records a `replace` event and, after every other change in the operation, a `replace-cleanup` event for the disposal of the old resource (`replace-retained` when `deletion_policy` is `retain`).

A `deleted` resource is an audit tombstone: `get-formation` still lists it; `plan-formation` (as a `delete` action) and `update-formation` report it once, at the deploy that removes it from the template; a later no-op reconcile never re-lists it.

### A Failed Deploy Still Answers 2xx

A deploy is a reconciler, so the two failure kinds are reported differently:

| What went wrong                                                                       | How it is reported                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| The template's **shape** — an unknown field, a missing required property, a bad `ref` | `400 VALIDATION_FAILED`, nothing is deployed                |
| The **reconciliation** — a resource the platform refused to create or update          | `201`/`200` with `status: "failed"` and a populated `error` |

**`2xx` means the deploy was attempted, not that it worked**; read `status`, then `error`:

```json
{
  "id": "form_V1StGXR8Z5jdHi6B",
  "status": "failed",
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "dataset_id is immutable: item 'dsit_…' belongs to 'dset_…'.",
    "meta": { "logical_id": "case1", "resource_type": "dataset_item" }
  }
}
```

`error.code` is the resource's own failure (`VALIDATION_FAILED`, `SECRET_NOT_FOUND`, `RESOURCE_NOT_FOUND`, …), and `error.meta` carries its details beside `logical_id` and `resource_type`; an unexpected failure reads `INTERNAL_ERROR` with `Internal Server Error`, as every [recorded failure](/docs/api#recorded-failures) does. `error` stays on `get-formation` while the stack is `failed`; the next successful deploy clears it. `list-formation-events` keeps every operation with the same `error` bag.

**The CLI exits non-zero on that body.** `create-formation` and `update-formation` print the payload to stdout (`$(…)` capture and `| jq` unaffected), write the reason to stderr and exit `1`:

{/* single-client: CLI exit-code behaviour */}

```bash
soat update-formation --formation-id "$F" --template "$T" && echo "deployed"
# update-formation: the deploy failed at resource 'case1' — the formation is
# 'failed'. VALIDATION_FAILED: dataset_id is immutable: …
# (exit 1 — "deployed" is not printed)
```

`get-formation` on a `failed` stack exits `0`; so do `plan-formation` / `validate-formation`, whose outcome is their payload.

### Rollback on a Failed Deploy

A deploy stops at the first failing resource and walks back every change it applied, newest first (a dependent before what it references), so the stack ends `failed` as it stood before the deploy:

- A **created** resource is deleted; a corrected re-deploy re-creates it from scratch.
- An **updated** resource is re-applied with the properties it had before; a nullable property the deploy set and the previous state lacked is cleared to `null`. A write-only property the deploy sent is sent again at the value the last successful deploy resolved; one that deploy cannot resolve (a `no_echo` parameter) keeps the value the failed deploy sent, and the next deploy sends it again.
- A **replaced** resource's replacement is deleted and the record points back at the resource it superseded.
- A `deletion_policy: retain` resource that was created or replaced survives; its record keeps pointing at it, so the next deploy adopts it rather than provisioning a duplicate.

Each unwind is an entry in the operation's `events` after the triggering failure: `rollback` (`completed` or `failed`) for a walked-back resource, `rollback-skipped` for a retained one. A failed `rollback` is reported, never thrown; the original error stays in the operation's `error`, and the record keeps pointing at the physical resource for manual cleanup.

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

Deletion is idempotent: a managed resource already removed outside the formation counts as gone. A teardown that cannot finish answers `409 FORMATION_DELETE_FAILED`, naming every blocker in `error.meta.failures` as `{ logical_id, resource_type, error }`, `error` being the blocker's own `{ code, message, meta? }` (`AGENT_HAS_DEPENDENTS`, `TOOL_HAS_DEPENDENTS`, `PLAYBOOK_HAS_CASES`, …).

**A predictable blocker is caught before anything is deleted.** Teardown pre-flights the resources it is about to remove; a foreseeable refusal destroys nothing, the stack stays `active`, and the same `delete-formation` succeeds once the blocker is resolved. The predictable blockers are an **agent with generation or trace history**, which the platform never force-deletes on its own ([`DELETE /api/v1/agents/{agent_id}?force=true`](/docs/api/agents/delete-agent) is an operator decision), and an **agent or tool a [decider](./deciders.md#formations) outside the stack names**. A decider in the same stack blocks nothing: it is deleted first. Declare the agent with `deletion_policy: retain` to leave it standing; a retained resource is never deleted, so never blocks. An eval run is one generation per dataset item, so an agent shipped with the eval that verifies it has history the moment the suite runs; see [Gate a Canary Promotion on an Eval](../tutorials/gate-a-canary-promotion-on-an-eval.md).

An **unforeseeable** error surfaces mid-teardown: resources removed before it stay removed (teardown does not roll back), the stack is left `delete_failed`, and the error message says which case applies. Resolve the blockers and delete again.

### Plan Diff

Each entry in `plan-formation`'s `changes[]` carries a `diff` object alongside `logical_id`, `resource_type`, `action`, and `physical_resource_id`:

| Field          | Type           | Description                                                                                                                                                                                      |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `diff.desired` | object         | Resolved desired-state properties, after parameter and `ref`/`sub` substitution — credential-bearing properties read as `{ "no_echo": true }`, see [Secrets in Templates](#secrets-in-templates) |
| `diff.current` | object \| null | Current properties being compared against — `null` when there is nothing to compare (a `create`, an unregistered resource type, or a failed read)                                                |

For a type whose live state can be read back (most), `diff.current` is the resource as it exists today; for a write-only type (`secret`), it is the last-applied snapshot on the formation resource, which `update-formation` also diffs against.

The `formation_id` a plan compares against is looked up in the plan's project only. An id that names no formation there, including one owned by another project, is treated as absent: every resource plans as a `create`, and nothing about the other project's formation is returned.

Plan and apply share one change rule:

- Only properties **the template declares** are compared; a field the resource carries but the template never declared is not a change.
- A property the last apply declared and the template now omits is **removed**: a nullable one is cleared (`null` in `diff.desired`, an `update`); any other keeps its value, shown in `diff.desired`. Operator-registered types keep every omitted property.
- A property is nullable in its type's properties schema only when the resource's update can clear it, so a declared `null` and an omitted nullable property both clear it. A property set only at creation, or one the update cannot clear (a policy's `name`, a webhook's `description`), refuses `null`.
- Comparison is **structural**; key order in a nested value bag is not a change.
- An **empty field** is not a change: a `null` field equals an absent one at every depth, so a declared `null` equals a property the read leaves out and a nested field the read holds `null` equals one the template omits; except a top-level write-only property, which no read returns.
- A **schema default** is not a change: both sides are compared with every `default` the type's properties schema declares filled in, at every depth, so a playbook node omitting `final` equals one read back with `final: false`. A value the deployment stores for an empty property fills in the same way: an `oauth_client` declaring `redirect_uri: null` equals one holding `OAUTH_DEFAULT_REDIRECT_URI`.
- A **write-only property** compares equal when it resolves to the value the formation last deployed, including one sent back as `{ "no_echo": true }`: the same declaration, each `param` it reads given the value that deploy recorded in `resolved_parameters`, and each `ref` naming a resource the deploy does not replace. A different value, or a `param` declared `no_echo` (never recorded), is a change.
- A property resolving to `undefined` (a kept `use_previous_value` parameter) reuses the previous value, or is dropped when there is none.

### A Formation Only Does What the Caller Could Do Directly

A formation is authorized twice: for the request (`formations:CreateFormation`, `formations:UpdateFormation`, `formations:DeleteFormation`, `formations:PlanFormation`) and **once per declared resource**, as the action a direct call would need: declaring a guardrail needs `guardrails:CreateGuardrail`, removing one needs `guardrails:DeleteGuardrail`. A `Deny` on a resource action applies to the formation path as to the route.

The check runs over the whole template **before anything is applied**: no formation is created, and a refused update or teardown leaves the stack `active`. The `403` names every missing action at once:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Forbidden: user user_01HXYZ's policies deny guardrails:CreateGuardrail on srn:proj_01HXYZ:guardrail:*",
    "meta": {
      "action": "guardrails:CreateGuardrail",
      "resource": "srn:proj_01HXYZ:guardrail:*",
      "denied_by": { "type": "user", "id": "user_01HXYZ" },
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

`denied_by` names the set that refused the first action, as on the [routes](./iam.md#what-a-denial-looks-like): an [IAM token](./iam.md#iam-tokens)'s bound is `iam_token`, not its key. The message lists the actions that set refused; `denied_actions` lists them all.

[`POST /api/v1/formations/plan`](/docs/api/formations/plan-formation) changes nothing, so it **reports** the same list under `unauthorized_actions` instead of refusing; the field is absent when the caller may perform every action the plan implies.

- A `policy` resource is a [project policy](./policies.md) of the formation's project, authorized as `policies:CreatePolicy` there; its `Allow` statements name that project's resources (`srn:<project_id>:<type>:<id>`), or omit `resource` for every resource of the project. Validation refuses an `Allow` on `*`, every project, a project glob or a non-SRN pattern; plan, create and update, which know the formation's project, also refuse one naming another project's id, with `400 VALIDATION_FAILED`.
- An `api_key` resource is minted **under the deploying caller**, as [`POST /api/v1/api-keys`](/docs/api/api-keys/create-api-key) mints under the requesting user; the owner's permissions are its ceiling, so declaring one needs only `api-keys:CreateApiKey`. A narrowed deploying key also bounds its `policy_ids` by the [same rule as the routes](./api-keys.md#a-narrowed-key-stays-inside-its-boundary); a refusal fails the apply with `API_KEY_POLICY_BOUNDARY`. A project-scoped token (OAuth or IAM) [writes no key](./api-keys.md#a-project-scoped-token-writes-no-key): the apply fails with `CREDENTIAL_NARROWED`.
- A `trigger` resource acts under its `policy_ids` ([execution identity](./triggers.md#execution-identity)), which the deploying caller must hold, so a firing never exceeds who declared it.
- A resource's `tags` are its [request tags](./iam.md#request-tags). A value computed from a `param`, `sub` or `ref` is unknown at this check, so a key any condition in the caller's policies names as `iam:RequestTag/<key>` is refused with `403 FORBIDDEN` whatever the value resolves to; a literal value is evaluated.
- A [custom resource type](#custom-resource-types) has no SOAT action, so it is gated on the request's `formations:*` action alone.

### Admission

A resource whose create or update action the deployment's [admission service](./iam.md#admission) is asked about is asked once per write, after its authorization and with its properties resolved, so a `ref`, `sub` or parameter value is seen as applied. A refusal fails that resource like any other failure: the deploy answers `2xx` with `status: failed` and the service's `code` (as sent, lowercase included), `message` and `meta` as its `error` (`ADMISSION_UNAVAILABLE` when the service did not answer), and the [rollback](#rollback-on-a-failed-deploy) runs. An operator-registered type is not asked: its handler decides its writes.

### Ids a Template Names Are Resolved Within Its Own Project

A property naming an existing resource by id (an `ai_provider`'s `secret_id`, a `session`'s `agent_id`, an `ingestion_rule`'s `tool_id`) resolves only within the deployment project. Another project's id fails the apply as though it did not exist, so the lookup cannot probe other projects. The exception is a tool or agent another project [shares](./shares.md#using-a-shared-tool) with the deployment project: an `ingestion_rule`'s `tool_id` or `agent_id` names it like one of the project's own while the share is accepted, and fails the apply with `Tool not found: <tool_id>` or `Agent not found: <agent_id>` once it is not. A `session`'s `agent_id` names one of the project's own agents only.

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

- **`name`** — the type a template writes; `^[a-z][a-z0-9_]*$`. A built-in name requires `overrides_builtin`.
- **`overrides_builtin`** — `true` replaces the built-in type of the same name. See [Overriding a built-in type](#overriding-a-built-in-type).
- **`handler`** — URL, the environment variable holding the signing secret, and the timeout.
- **`capabilities`** — the **optional** operations the handler implements (below). `create`, `update` and `delete` are always required and never listed.
- **`schema`** — JSON Schema for `properties`; the sole allowlist. An undeclared field is `VALIDATION_FAILED` naming the field; a missing `required` field fails a create.
- **`write_only_properties`** — properties whose values are never stored. See [Credentials](#credentials-and-write-only-properties).
- **`writer`** — required: what a write performs, asserted for the deployer before the handler is called. See [What a write performs](#what-a-write-performs).

#### What a write performs

The runtime authorizes a registered type's writes; the handler authorizes nothing. `writer` declares:

- **`resource_type`**, and the **`create`**, **`update`** and **`delete`** actions: each request takes its action, on `srn:<project_id>:<resource_type>:*` for a create and on the resource's physical id otherwise.
- **`carries`**: for each property naming a resource, the action it carries on it (`{ "property": "default.agent_id", "action": "agents:CreateAgentGeneration", "resource_type": "agent" }`). `[]` descends into a list (`tools[]`). Checked on the values after resolution, as sent to the handler; a value that is not an id is `VALIDATION_FAILED`.
  A property whose values are names rather than ids carries actions keyed by value instead, each on `srn:<project_id>:<resource_type>:*`, or on the whole project, `srn:<project_id>:*:*`, for `"resource_type": "*"` (`projects:GetProject`); a value with no key is `VALIDATION_FAILED`, and a key mapped to `[]` carries nothing:

  ```json
  {
    "property": "events[]",
    "by_value": {
      "task.created": [{ "action": "tasks:GetTask", "resource_type": "task" }],
      "*": [{ "action": "tasks:GetTask", "resource_type": "task" }]
    }
  }
  ```

The deployer must hold all of them, else the resource fails with `ACTION_NOT_HELD` and the handler is never called. Every declared action must be one [`POST /api/v1/iam/check`](/docs/api/iam/check-iam-permission) answers on its type (a built-in one, or one a [registered IAM module](./iam.md#deployment-registered-actions) declares), or the boot fails; a deployment's own routes ask `iam/check` the same actions from the same declaration.

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

Each call carries these headers, and its `X-Request-Id` ([`SOAT_HEADER_PREFIX`](../self-hosting/configuration.md#header-prefix) replaces `X-Soat-`):

| Header                   | Meaning                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Soat-Signature`       | `t=<unix>,v1=<hex hmac-sha256 of "{t}.{body}">`, keyed with the registration's secret — the same scheme [webhooks](./webhooks.md) are signed with. Verify over the **raw** body bytes, and reject a stale `t`.                                                                                                  |
| `X-Soat-Idempotency-Key` | Stable per (resource, operation) across re-applies, distinct between resources. A handler that has already completed this key can answer with the same result instead of acting twice.                                                                                                                          |
| `X-Soat-Causation`       | When the call runs for an [event trigger](./triggers.md#loops-and-cost): the trigger chain, forwarded unchanged on a callback ([Causation](./tools.md#causation-x-soat-causation)).                                                                                                                             |
| `X-Soat-Tool-Assertion`  | On `create`, `update` and `delete` only, when the deployment sets [`TOOL_ASSERTION_PRIVATE_KEY`](./tools.md#configuration): a [tool assertion](./tools.md#tool-assertions) naming the project, with no `tool_id`, whose `ath` carries the authority of the credential that deployed or tore down the formation. |

What a 2xx must answer with, per operation:

| `request_type` | Response body                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `create`       | `{ "physical_resource_id": "…", "outputs": { … } }` — the id is required                                           |
| `update`       | the same shape; a **different** `physical_resource_id` means the resource was replaced                             |
| `delete`       | `{}` — and it must be idempotent: deleting an already-gone resource is a 2xx                                       |
| `validate`     | `{ "errors": [{ "path": "properties.kind", "message": "…" }] }` — an empty list means valid                        |
| `read`         | `{ "exists": true, "physical_resource_id": "…", "properties": { … }, "outputs": { … } }`, or `{ "exists": false }` |

**The handler acts as the deployer.** A registered type is gated on the formation's own actions only, so a handler that calls back into SOAT sends that assertion, unchanged, in `X-Soat-On-Behalf-Of` with its project's API key: the callback is then capped by the deploying credential, narrowings and an [IAM token](./iam.md#iam-tokens)'s bound included, exactly as a [tool server's callback](./tools.md#writing-on-behalf-of-a-tool-call) is. The assertion expires 60 seconds after it is signed; `validate` and `read` act for nobody and carry none.

To refuse, answer 4xx/5xx with `{ "message": "…" }`; the message is relayed verbatim on the deploy event. Any non-2xx, unreachable host, timeout, 2xx body over 8 MiB, or body outside the protocol fails the deploy with `FORMATION_HANDLER_FAILED` and enters the ordinary [rollback](#rollback-on-a-failed-deploy) path.

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

- **A write-only property is compared with its last deployed declaration**: a declaration resolving to the value the formation last deployed is not a change; a different value, or one from a `no_echo` parameter, is, and is sent again (the handler is expected to be idempotent). See [Plan Diff](#plan-diff).
- **`read` should not return it either**: a credential echoed in `read.properties` goes straight back into the drift comparison.

#### Overriding a built-in type

An entry whose `name` is a built-in type and that sets `overrides_builtin: true` replaces that built-in on the deployment: every template resource of that type goes to the handler, with the registered `schema`, and is gated on the formation's own actions instead of the built-in's IAM actions. The built-in's routes are unchanged. The flag is a boot failure on a name that is not a built-in, and a built-in name without it is a boot failure too.

Resources of that type already in the resource ledger are handed to the handler as well, which does not know their ids: `read` reports them gone and the next deploy recreates them. Override a type only on a deployment whose ledger holds none.

#### Disabling a built-in type

`disabled_resource_types` in the same file lists built-in types the deployment does not serve. Validate answers `200` with `valid: false`, and plan and deploy answer `400 VALIDATION_FAILED`, for every template declaring one, whoever the caller is; the error lists only the types the deployment serves. The type's own routes are unchanged.

A formation that already holds a resource of a disabled type can still be deleted, which tears that resource down. An update must drop the resource from its template, which deletes it.

#### Replacement

When an `update` answers with a different `physical_resource_id`, the resource record is re-pointed at it, every `ref` resolves to the new id, and the old resource is disposed of under the resource's `deletion_policy` (`retain` leaves it alive).

Cleanup is **deferred to the end of the operation**, after every other change and orphan removal, so dependents are re-pointed by then and a type whose delete refuses while referenced (an `ai_provider` answers `409` while an agent, chat or model route names it; `force` does not override that) is deletable when the disposal runs.

A disposal that still fails never fails the deploy (the desired state is realised). It is reported twice and retried:

- a failed `replace-cleanup` event on the operation, and
- `error.code: "FORMATION_REPLACE_CLEANUP_FAILED"` on the formation itself while the resource is still live, with `error.meta.failures` naming each `{ logical_id, resource_type, physical_resource_id, error }`. The formation stays `active` and the operation stays `completed`.

The un-deleted id stays on the record as pending cleanup; the next deploy and the teardown retry it and clear the error once it succeeds. A pending cleanup failing during teardown is recorded but never leaves the formation `delete_failed`.

## Configuration

| Environment Variable              | Required | Description                                                                                                                                                                                                |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORMATION_RESOURCE_TYPES_CONFIG` | No       | Path to a JSON file registering [custom resource types](#custom-resource-types) and [disabling built-in ones](#disabling-a-built-in-type). Unset (the default) means the built-in types are the whole set. |

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
      "writer": {
        "resource_type": "channel",
        "create": "channels:CreateChannel",
        "update": "channels:UpdateChannel",
        "delete": "channels:DeleteChannel",
        "carries": [
          {
            "property": "agent_id",
            "action": "agents:CreateAgentGeneration",
            "resource_type": "agent"
          }
        ]
      },
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
  ],
  "disabled_resource_types": ["api_key", "chat"]
}
```

`resource_types` is required (`[]` registers nothing); `disabled_resource_types` is optional.

The secret is referenced by variable **name**, never inlined, so the file carries nothing confidential. It is read **once, at boot**; changes take effect on the next restart.

Every problem with the file is a **hard boot failure** naming the file and the offending entry: a built-in name without `overrides_builtin: true`, an `overrides_builtin` on a name that is not a built-in or that is not a boolean, a name that repeats within the file, a handler URL that is not `http(s)`, a `secret_env` naming a variable that is unset or empty, a non-positive timeout, an unknown capability, a `write_only_properties` entry the schema does not declare, a missing or malformed `writer`, a `carries` property whose root the schema does not declare, a `writer` action `iam/check` does not answer on its type (IAM registrations load first), a `schema` that is not an object schema, or a `disabled_resource_types` entry that is not a built-in, repeats, or is also registered in `resource_types`.

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
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.formations.createFormation({
  body: {
    project_id: 'proj_ABC',
    name: 'my-stack',
    template: {
      resources: {
        MyProvider: {
          type: 'ai_provider',
          properties: {
            name: 'GPT-4o',
            provider: 'openai',
            default_model: 'gpt-4o',
          },
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
    template: {/* updated template */},
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
