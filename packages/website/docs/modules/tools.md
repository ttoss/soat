---
description: "Standalone, reusable tool definitions that SOAT agents call during generation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Tools

Standalone, reusable tool definitions that agents call during generation.

## Overview

A tool is one project-scoped record of type, input schema and execution config, shareable across agents and callable directly via the API. Types: `http` (external HTTP endpoint), `client` (executed locally by the calling application), `mcp` (proxies an MCP server), `builtin` (SOAT platform action), `pipeline` (fixed sequence of other tools as one call). Any other `type` is `400 VALIDATION_FAILED` on create and update.

A [Trigger](./triggers.md) with `target_type: tool` invokes a tool automatically. A [Guardrail](./guardrails.md) on the tool (every agent) or on the agent classifies calls and routes them to the [approval queue](./approvals.md).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Execute Agent Tool Calls in Your Own App - Step 4 (Declare the function as a client tool)](/docs/tutorials/client-tools#step-4--declare-the-function-as-a-client-tool)
- [Agent SOAT Tools and Preset Parameters - Step 6 (Create builtin tools)](/docs/tutorials/agent-soat-tools#step-6--create-builtin-tools)
- [Orchestrate a Sonnet - Step 4 (Create the fixed write tool)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 5 (Create fixed builtin tools)](/docs/tutorials/multi-agent-orchestration#step-5--create-fixed-builtin-tools-for-stanza-agents)
- [Agent over a Library of PDFs - Step 12 (Give the agent a knowledge tool)](/docs/tutorials/agent-with-pdfs#step-12--give-the-agent-a-knowledge-tool-plan-d)
- [Call AWS and GCP APIs from an Agent - Step 3 (Create a SigV4-signed S3 tool)](/docs/tutorials/call-aws-and-gcp-apis-from-an-agent#step-3--create-a-sigv4-signed-s3-tool)

## Data Model

| Field               | Type                                            | Description                                                                                                       |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                | `string`                                        | Public ID (`tool_` prefix)                                                                                        |
| `project_id`        | `string`                                        | ID of the owning project                                                                                          |
| `name`              | `string`                                        | Machine-readable tool name sent to the model (or namespace prefix for `mcp`/`builtin`)                               |
| `type`              | `"http"` \| `"client"` \| `"mcp"` \| `"builtin"` \| `"pipeline"` | Tool type — determines execution behaviour                                        |
| `description`       | `string \| null`                                | Human-readable description sent to the model for tool selection                                                   |
| `parameters`        | `object \| null`                                | JSON Schema describing the tool's input. Required for `http` and `client` types.                                  |
| `execute`           | `object \| null`                                | HTTP execution config (`url`, `method`, `headers`, `body_mode`, `auth`). Required for `http` type.                |
| `execute.url`       | `string`                                        | HTTP endpoint. Supports `{paramName}` and `${body.fieldName}` path placeholders replaced at call time with URL-encoded argument values.   |
| `execute.method`    | `string`                                        | HTTP method (default: `POST`). For `GET`, `HEAD`, `DELETE` the arguments become query-string parameters.          |
| `execute.headers`   | `object`                                        | Additional headers sent with the execution request.                                                               |
| `execute.body_mode` | `"json" \| "multipart"`                         | How the request body is encoded for `POST`/`PUT`/`PATCH` (default: `json`). Use `multipart` for APIs that require `multipart/form-data`. |
| `execute.auth`      | `object \| null`                                | Computed request credential, for targets whose `Authorization` value cannot be a static header. `type` is `aws_sigv4` or `gcp_service_account`. See [Computed credentials](#computed-credentials-executeauth). |
| `mcp`               | `object \| null`                                | MCP server config (`url`, `headers`). Required for `mcp` type.                                                    |
| `mcp.url`           | `string`                                        | URL of the MCP server (SSE or Streamable HTTP transport).                                                         |
| `mcp.headers`       | `object`                                        | Additional headers sent when connecting to the MCP server.                                                        |
| `actions`           | `string[] \| null`                              | Allowlist of actions to expose. `builtin`: SOAT platform action names, e.g. `["search-knowledge"]` (required). `mcp`: optional allowlist of MCP tool names to scope the server surface — `null` exposes every tool. See [mcp action scoping](#scoping-an-mcp-tool-to-a-subset-of-actions). |
| `denied_actions`    | `string[] \| null`                              | `mcp` only: optional denylist of MCP tool names to hide, applied after `actions` and taking precedence over it. `null` denies nothing. See [mcp action scoping](#scoping-an-mcp-tool-to-a-subset-of-actions). |
| `context_keys`      | `string[] \| null`                              | Allowlist of [`tool_context`](../advanced/tool-context.md) keys forwarded to this tool as context headers. `null` forwards every key (the default); `[]` forwards none. See [Scoping which context keys reach a tool](#scoping-which-context-keys-reach-a-tool). |
| `preset_parameters` | `object \| null`                                | Fixed parameter values pinned on every call. Keys are hidden from the model, and a pinned value wins over one the caller sends. Values accept [`{{context:<key>}}`](../advanced/tool-context.md#pinning-a-parameter-to-the-runs-value) so a pin can be the *run's* value. |
| `pipeline`          | `object \| null`                                | Pipeline definition (`steps`, optional `output`). Required for `pipeline` type. See [pipeline](#pipeline).         |
| `output_mapping`    | `object \| null`                                | JSON Logic mapping applied to the tool's raw result, for every tool type. See [output mapping](#output-mapping).   |
| `guardrail_ids`     | `array \| null`                                 | Guardrails attached at the tool scope, governing this tool wherever it is used — see [Guardrails — Attachment](./guardrails.md#attachment) |
| `created_at`        | `string`                                        | ISO 8601 creation timestamp                                                                                       |
| `updated_at`        | `string`                                        | ISO 8601 last-updated timestamp                                                                                   |

## Key Concepts

### Header Name Casing

Header names in `execute.headers` and `mcp.headers` are preserved verbatim (`Authorization` stays `Authorization`).

### Context Headers (`X-Soat-Context-*`)

Every `http` and `mcp` call carries the generation's [`tool_context`](../advanced/tool-context.md) as `X-Soat-Context-*` headers (plus the auto-populated `session_id`, `actor_id` and `actor_external_id`), injected after the configured headers. The prefix is deployment configuration ([`TOOL_CONTEXT_HEADER_PREFIX`](../self-hosting/configuration.md#agent-generation)), so a caller cannot overwrite a tool's own credential. A [`{{context:<key>}}` token](#context-references-in-headers) places a context value in a header the target expects; [`context_keys`](#scoping-which-context-keys-reach-a-tool) bounds which keys reach a tool (default: all, for `http`, `mcp` and `builtin`). Key→header rule and security notes: [Tool Context reference](../advanced/tool-context.md).

### Tool ID vs Tool Name

A **tool ID** (`tool_k8x2f3np`) is used in [`tool_bindings`](./agents.md#tool-bindings), `active_tool_ids` and `step_rules[].active_tool_ids`; a **tool name** is what the model sees and what `tool_choice` and `stop_conditions` use. `http`/`client`: one ID, one name; `mcp`/`builtin`: one ID, many names.

### Tool Name Resolution

| Tool type | Name the model sees    | Example                                              |
| --------- | ---------------------- | ---------------------------------------------------- |
| `http`    | `{name}`               | `search`                                             |
| `client`  | `{name}`               | `read_local_file`                                    |
| `mcp`     | `{name}_{mcpToolName}` | `github_create_issue`, `github_list_repos`           |
| `builtin`    | `{name}_{action}`      | `platform_get-document`, `platform_search-knowledge` |

For `mcp` and `builtin`, `name` is a prefix joined with `_` to each sub-tool name (`github_search` vs `jira_search`).

### http

The server sends the arguments to `execute.url` with the configured method: as a JSON body for `POST`, `PUT`, `PATCH`; as query-string parameters for `GET`, `HEAD`, `DELETE`.

:::caution Pointing a `GET` tool at this API

Every leftover argument becomes a query parameter, so a `GET` tool at a SOAT endpoint may only take arguments that endpoint declares; an undeclared one is a [`400`](./usage.md#narrowing-a-rollup), surfaced as `TOOL_HTTP_ERROR`. Prefer a `builtin` tool.

:::

Two placeholder syntaxes inject arguments into the URL path; a consumed argument leaves the body or query string:

- **`{paramName}`** — the URL-encoded argument; for tools defined via the API or CLI.
- **`${body.fieldName}`** — the same inside formation template `sub` expressions, where `${...}` is the interpolation syntax (`url: { sub: '${AppUrl}/posts/${body.post_id}' }`).

Example — a `DELETE` tool with path parameters:

```json
{
  "name": "delete-post",
  "type": "http",
  "execute": {
    "url": "https://api.example.com/users/{user_id}/posts/{post_id}",
    "method": "DELETE"
  },
  "parameters": {
    "type": "object",
    "properties": {
      "user_id": { "type": "string" },
      "post_id": { "type": "string" }
    },
    "required": ["user_id", "post_id"]
  }
}
```

Called with `{ "user_id": "123", "post_id": "456" }`, the server issues `DELETE https://api.example.com/users/123/posts/456`.

#### Secret references in `execute`

[`GET /tools/{id}`](/docs/api/tools/get-tool) echoes `execute` to anyone with read access, so use a [secret reference](./secrets.md#secret-references-secret) rather than a raw credential: `"headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" }`.

`{{secret:...}}` works in `execute.url` and `execute.headers` values, resolved right before the outbound request; the stored tool and every `GET`/`LIST` keep the reference. The secret must exist in the same project (`400 SECRET_NOT_FOUND` at create/update).

Secret and [context](#context-references-in-headers) references are the only valid double-curly forms; any other `{{...}}` in `execute` or `mcp` is `400 INVALID_TEMPLATE_TOKEN` at create/update. [URL path placeholders](#http) use single braces (`{param}`). Full reference: [Expressions & Templating](../advanced/expressions-and-templating.md).

#### Context references in headers

A `{{context:<key>}}` token in `execute.headers` or `mcp.headers` is substituted per call with one key of the caller's [`tool_context`](../advanced/tool-context.md): `"headers": { "Authorization": "Bearer {{context:ocaToken}}" }`.

| | |
| --- | --- |
| Valid in | `execute.headers` and `mcp.headers` only. In `execute.url`, `mcp.url`, `execute.auth` or a body it is rejected with `400 INVALID_TEMPLATE_TOKEN` — a caller-supplied value must not be able to steer the outbound URL. |
| Missing key at call time | The call fails with `400 MISSING_TOOL_CONTEXT_KEY`, naming the key and header, rather than sending an empty credential. |
| Read back | `GET`/`LIST` echo the token, never the resolved value — same as `{{secret:...}}`. |
| Calling paths | Every dispatch surface carries a bag: an agent generation, a session, an orchestration `agent`, `tool` or `poll` node, a `pipeline` step, and [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool) via its own `tool_context` field. |

#### Scoping which context keys reach a tool

`tool_context` is forwarded in full to every `http`, `mcp` and `builtin` tool; `context_keys` bounds it per tool. With `"context_keys": ["tenant"]` and `tool_context: { "ocaToken": "...", "tenant": "acme" }`, the tool receives `X-Soat-Context-tenant`, not `X-Soat-Context-ocaToken`.

| | |
| --- | --- |
| Omitted or `null` | Every key is forwarded. This is the default. |
| `[]` | No caller key is forwarded. |
| Identity keys | `session_id`, `actor_id` and `actor_external_id` are server-derived and always forwarded regardless of the list. |
| `{{context:<key>}}` tokens | Substituted regardless of the list: the tool declared that header itself. A key used only in a token need not be listed. |
| `builtin` tools | The list also bounds the `tool_context` propagated in the action's request body, so a nested generation inherits only the listed keys. |
| Matching | Case-insensitive (a key names a header). |
| Invalid entry | An entry outside the [key grammar](../advanced/tool-context.md) is rejected at write time with `400 INVALID_TOOL_CONTEXT_KEY`. |

The allowlist is per tool, not per agent.

#### Computed credentials (`execute.auth`)

`execute.auth` authenticates targets a static header cannot: AWS (per-request Signature Version 4 HMAC) and Google (short-lived OAuth 2.0 token from a signed service account assertion). It is a strategy on the `http` transport, not a tool type; `parameters`, path placeholders, `body_mode`, `output_mapping`, `preset_parameters`, guardrails, approvals, pipeline steps and `502 TOOL_HTTP_ERROR` mapping are unchanged.

| `auth.type`             | Required fields                                                        | Optional fields | What is sent |
| ----------------------- | ---------------------------------------------------------------------- | --------------- | ------------ |
| `aws_sigv4`             | `region`, `service`, `access_key_id`, `secret_access_key`              | `session_token` | `Authorization: AWS4-HMAC-SHA256 …`, `X-Amz-Date`, plus `X-Amz-Security-Token` and `X-Amz-Content-Sha256` when applicable |
| `gcp_service_account`   | `credentials` (service account key file JSON, as a string), `scopes`    | —               | `Authorization: Bearer <access token>` |

Credential values take [secret references](./secrets.md#secret-references-secret), stored and returned as-is, resolved only before signing:

```json
{
  "name": "get-s3-object",
  "type": "http",
  "description": "Reads an object from an S3 bucket",
  "parameters": {
    "type": "object",
    "properties": { "key": { "type": "string" } },
    "required": ["key"]
  },
  "execute": {
    "url": "https://my-bucket.s3.us-east-1.amazonaws.com/{key}",
    "method": "GET",
    "auth": {
      "type": "aws_sigv4",
      "region": "us-east-1",
      "service": "s3",
      "access_key_id": "{{secret:sec_01HAWSKEYID}}",
      "secret_access_key": "{{secret:sec_01HAWSSECRET}}"
    }
  }
}
```

- **Signing happens last**, over the final method, URL, headers and body. Only SOAT-controlled headers are signed (`host`, `content-type`, `x-amz-*`); [context headers](#context-headers-x-soat-context-) and `Idempotency-Key` go unsigned (AWS permits it).
- **`aws_sigv4` with `body_mode: "multipart"`** is `400 VALIDATION_FAILED` at create/update: the body bytes are unknown at signing time.
- **Path encoding follows the service**: segments are URI-encoded twice except for `s3` (once), per the SigV4 spec.
- **GCP tokens are cached** per service account, token endpoint and scope set, refreshed shortly before expiry.
- **`service` and `region` are signed**, not just routing; a mismatch is rejected by the target.
- **Credential failures are `502 TOOL_AUTH_FAILED`** (distinct from `502 TOOL_HTTP_ERROR`, the target rejecting the call); a token endpoint's status and body land in error `meta` as `upstream_status` and `upstream_body`.

Every `auth` field is validated at create/update (`400 VALIDATION_FAILED`) and by `validate-formation`.

#### Request body encoding (`body_mode`)

The caller's `input` is the request body verbatim (keys never case-transformed). `POST`, `PUT` and `PATCH` default to JSON (`Content-Type: application/json`); `execute.body_mode` set to `"multipart"` sends `multipart/form-data`:

- Scalars (string, number, boolean) become form fields.
- A `{ content_type, filename, data_base64 }` field (the shape an [ingestion rule](./ingestion-rules.md) passes for the uploaded file) is base64-decoded and attached as a file part with that filename and content type.
- `Content-Type` is left unset so `fetch` generates the boundary (any `Content-Type` in `execute.headers` is dropped).

### client

Client tools have no server-side `execute`. A call pauses the generation with `status: "requires_action"` and the pending tool calls; the caller executes locally and submits results via [`POST /agents/{agent_id}/generate/{generation_id}/tool-outputs`](/docs/api/agents/submit-agent-tool-outputs), which answers with a final result or another `requires_action`.

Resuming continues the paused turn: the agent's [`tool_choice`](./agents.md#tool-choice) applies, [`step_rules`](./agents.md#step-rules) keep counting from the turn's first step, and only what remains of [`max_steps`](./agents.md#stop-conditions) can be spent.

Response when a client tool is called:

```json
{
  "status": "requires_action",
  "generation_id": "gen_abc123",
  "required_action": {
    "type": "submit_tool_outputs",
    "tool_calls": [
      {
        "tool_call_id": "call_xyz",
        "tool_name": "read_local_file",
        "args": { "path": "/tmp/data.csv" }
      }
    ]
  }
}
```

Submitting tool outputs:

```json
POST /agents/{agent_id}/generate/{generation_id}/tool-outputs

{
  "tool_outputs": [
    {
      "tool_call_id": "call_xyz",
      "output": "col1,col2\n1,2\n3,4"
    }
  ]
}
```

### mcp

An `mcp` tool proxies a [Model Context Protocol](https://modelcontextprotocol.io/) server: at generation time its tools are discovered and registered with the model (one tool ID, many names, each with the advertised name, description and parameters); each call is forwarded and the result fed back.

`mcp.url` and `mcp.headers` accept [secret references](./secrets.md#secret-references-secret) (resolved before connecting, as for [`http` headers](#secret-references-in-execute)); `mcp.headers` also accepts [`{{context:<key>}}`](#context-references-in-headers).

#### Scoping an MCP tool to a subset of actions

By default an `mcp` tool exposes the whole server surface. `actions` allowlists MCP tool names:

```json
{
  "name": "oneclick",
  "type": "mcp",
  "mcp": { "url": "https://mcp.oneclick.example/sse" },
  "actions": ["list_campaigns", "get_campaign"]
}
```

Only allowlisted tools are registered with the model; [`POST /tools/{id}/call`](/docs/api/tools/call-tool) and `pipeline` steps reject an `action` outside it with `400 VALIDATION_FAILED` before contacting the server.

Omitted or `null` exposes everything; `[]` nothing. MCP names are discovered at runtime, not validated at create/update (unlike `builtin`); an unadvertised name is never exposed.

`denied_actions` is a denylist (for a read+write server where enumerating every read tool would drift), enforced at the same points, applied after `actions` and winning: a name in both is denied. Omitted or `null` denies nothing.

### builtin

A `builtin` tool exposes the SOAT platform actions listed in `actions`, named as the platform's MCP tools (`get-document`, `search-knowledge`, `create-file`), not REST operationIds (`search-knowledge`, not `searchKnowledge`). Worked example: [Orchestrate a Sonnet - Step 4 (Create the fixed write tool)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool).

Create/update validates every entry against the registry: an unknown name is `400 VALIDATION_FAILED`; a camelCase name matching a kebab-cased action gets a suggestion (`"searchKnowledge" (did you mean "search-knowledge"?)`).

A non-2xx action response is `502 TOOL_HTTP_ERROR` with the real status in `meta.tool_status_code`. A `204 No Content` answer (every `delete-*`) yields `null`.

Operations whose response cannot be a tool result are `400 VALIDATION_FAILED` at create: `download-file` (raw bytes; use `download-file-base64`) and `export-audit-entries` (unbounded NDJSON; use `list-audit-entries`); both remain over REST, SDK and CLI. `create-agent-generation` has no `stream` and returns the completed generation.

#### Actions an agent may not be given

These actions are withheld from agents whatever the caller's credential allows; naming one in `actions` is `400 VALIDATION_FAILED` on create and update:

| Actions | Why |
| --- | --- |
| `approve-approval`, `reject-approval` | An [approval](./approvals.md) exists to put a person between an agent and an action; an agent that settles its own has removed them |
| `create-api-key`, `update-api-key`, `delete-api-key`, `get-api-key`, `login-user`, `bootstrap-user` | Mint or return a credential |
| `get-trigger-secret`, `rotate-trigger-secret`, `get-webhook-secret`, `rotate-webhook-secret` | Return or replace signing secrets |
| `create-secret`, `update-secret`, `delete-secret` | Write [secret](./secrets.md) material. `get-secret` stays available: it answers `has_value`, never the value |
| `attach-user-policies`, `create-policy`, `update-policy`, `delete-policy`, `create-user`, `delete-user`, `list-users`, `get-user` | Change or enumerate who may do what |
| `update-ai-provider-prices`, `update-project-prices` | Rewrite the price book its own spend is metered against. The `get-*` twins stay available |

Over [MCP](../mcp/introduction.md) these are ordinary operations (the caller is a person acting as themselves). A tool row created before an action joined the list keeps it stored; the agent's surface leaves it out. An `mcp` tool pointed at this deployment's own MCP endpoint reaches them again; prefer a `builtin` tool.

#### The project a builtin action acts on

On every action that takes `project_id` the server pins it to the agent's own project and removes it from the model's schema. The pin outranks a [preset parameter](#preset-parameters) naming another project and applies to agent tool calls only; a direct [`POST /tools/{tool_id}/call`](/docs/api/tools/call-tool) is unaffected.

#### How a builtin action is executed

The action runs in-process through the same middleware stack and route handler as a client request (no network hop): per-call permission check against the caller's policies, strict field validation, audit logging, metering and quotas, and the snake_case response contract all apply. No ambient authority: an action the credential cannot perform fails with `502 TOOL_HTTP_ERROR` / `meta.tool_status_code: 403`. A call not settled within `SOAT_TOOL_CALL_TIMEOUT_MS` (default `300000`) fails with a timeout error. From an orchestration the tool acts as the run's own identity — [Run identity](./orchestrations.md#durable-background-execution).

Mid-turn agent calls inject `tool_context`, `parent_trace_id`, `root_trace_id` and `max_call_depth` only for actions whose REST schema declares them (currently only `create-agent-generation`).

### pipeline

A `pipeline` tool runs a fixed, ordered sequence of other tools as one call (`compute → persist`) server-side, with no model reasoning between steps; callable by orchestration `tool` nodes and directly via the API.

`pipeline` has `steps` and an optional `output`:

- **`steps[]`** — each step names a tool by **`tool_id`** or an inline **`tool`** ([Create Tool](#data-model) body minus `project_id`, no Tool row, not itself `pipeline`), never both; in a [formation](./formations.md) template `tool_id` may be `{ "ref": "ResourceName" }` to another template tool, resolved at deploy. Optional **`action`** for `builtin`/`mcp` step tools. **`input`** maps keys to [JSON Logic](https://jsonlogic.com) expressions over `{ input, steps }`:
  - `{ "var": "input.<field>" }` reads the pipeline's own input; `{ "var": "steps.<id>.<path>" }` an earlier step's output.
  - Literals pass through; transforms (`cat`, `+`, `if`, `map`, `filter`, `reduce`, …) resolve recursively at any depth.
  - A value is an expression only when it is a single-key object whose key is a real JSON Logic operator; `preserve` returns its argument unevaluated for a literal that looks like one: `{ "preserve": { "var": "some.var" } }`.
- **`output`** (optional) — a JSON Logic expression building the return value (default: the last step's raw output); may be a bare scalar (`{ "var": "steps.<id>.<path>" }`) or an object with nested expressions.

Each step's output is captured under `steps.<id>`; a step may reference only earlier steps (forward references rejected at create). The first failing step aborts with `PIPELINE_STEP_FAILED`. Nested `pipeline` targets are bounded by a maximum depth (`PIPELINE_DEPTH_EXCEEDED`). Steps cannot target `client` tools.

> **Case convention.** Structural keys are snake_case (`tool_id`, `steps`, `input`, `output`). A step's `input` keys are preserved verbatim as the sub-tool's arguments; author them, and `var` paths, in the casing of the data.

For LLM-decided multi-step flows see [Orchestrations](./orchestrations.md), which share the JSON Logic mapping model.

**Validation.** [`POST /tools`](/docs/api/tools/create-tool), [`PATCH /tools/:id`](/docs/api/tools/update-tool) and `validate-formation` check the structure: every step needs a `tool_id` or an inline `tool` with a `name`; a `{ "ref": … }` `tool_id` is accepted in a formation template only (direct `POST`/`PATCH` need a literal string). `validate-formation` also warns (not errors) on a `parameters` property no step `input` or `output` reads via `{ "var": "input.<name>" }`.

### Output Mapping

`output_mapping` is a [JSON Logic](https://jsonlogic.com) mapping over `{ "output": <raw result>, "input": <merged input> }`, applied to every tool type's raw result: `{ "var": "output.text" }` extracts a scalar without a wrapping `pipeline`, `{ "var": "input.title" }` echoes a request field, an object reshapes:

```json
{ "transcript": { "var": "output.text" }, "language": { "var": "output.language" } }
```

`input` is the caller-supplied `input` with `preset_parameters` pinned over it.

- **`pipeline` tools.** The top-level `output_mapping` runs after the pipeline's own `output` mapping, over its final result.
- **`client` tools.** Applied when the submitted output is materialized back into the generation, keyed by tool name.
- **`input`** is populated for a direct call ([`POST /tools/{id}/call`](/docs/api/tools/call-tool)), a pipeline step or a workflow/orchestration tool dispatch; `{}` for a tool the model calls from an agent's loop and for a `client` tool's mapping.
- **A `var` path resolving to `null`** (commonly a missing `output.` prefix) emits a debug log entry; the result is unchanged.

Without `output_mapping` the raw result is returned unchanged.

### Preset Parameters

`preset_parameters` pins fixed values: a key matching an input-schema field is removed from the schema shown to the model and merged into every call before dispatch. Several tools can target different resources from one action: two `builtin` tools binding `update-document`, one with `"preset_parameters": { "id": "doc_abc123" }`, one with `{ "id": "doc_xyz789" }`. End to end: [Agent SOAT Tools and Preset Parameters - Step 6 (Create builtin tools)](/docs/tutorials/agent-soat-tools#step-6--create-builtin-tools).

**A preset is a pin, not a default: it wins.** A value the call supplies for a pinned key (a model naming the hidden field, or an `input` to [`POST /tools/{id}/call`](/docs/api/tools/call-tool)) is replaced by the preset; unpinned keys come from the call. No tool schema sets `additionalProperties: false`, so a hidden key is not rejected; merge order is the guarantee.

Holds on every tool type (`builtin`, `http`, `mcp`, `client`, `pipeline`) and dispatch surface (agent tool loop, direct call, pipeline step, orchestration tool node, converter invocation). A guardrail evaluates the pinned arguments (`args.*` in a guard condition, `arguments` on an approval item); a `client` tool receives them pinned at the `requires_action` boundary. On an `mcp` binding presets apply to every tool the server exposes, as to every action a `builtin` binding lists; use a separate binding for a key meant for one.

#### Pinning to a per-run value (`{{context:}}`)

A preset value may be a [`{{context:<key>}}`](../advanced/tool-context.md#pinning-a-parameter-to-the-runs-value) token, resolved per call from the caller's `tool_context`:

```json
{
  "type": "mcp",
  "mcp": { "headers": { "Authorization": "Bearer {{context:ocaToken}}" } },
  "context_keys": ["ocaToken", "ocaAdAccountId"],
  "preset_parameters": { "adAccountId": "{{context:ocaAdAccountId}}" }
}
```

Credential and scope both come from the run, neither from the model. A key missing from the call's `tool_context` is `400 MISSING_TOOL_CONTEXT_KEY` (the literal placeholder is never sent); a resolved value is retyped to the parameter's declared schema type. `{{secret:...}}` is not resolved in a preset (secrets are headers-only).

Presets and model arguments reach the action wherever the OpenAPI operation declares the parameter (path, query, body): a `list-*` action's `project_id`, filters and pagination are query parameters, so `{ "project_id": "proj_abc123" }` locks a `builtin` tool to one project. An omitted argument is left out, never sent empty.

### Literal Credentials Are Masked on Read

A tool is readable by anyone holding `tools:GetTool`, so a literal credential is stored and sent on every call but never echoed: `secret_access_key`, `session_token` and `credentials` under `execute.auth`, and any credential-named `headers` value in `execute` or `mcp` (`Authorization`, `Cookie`, or a name containing `api-key` / `token` / `secret` / `password`) read back as `{"no_echo": true}`. The mask is an object so a read-edit-write round trip fails the schema's `type: string` check instead of storing the placeholder as the credential.

A `{{secret:...}}` reference stays readable; it is the wiring, not the credential.

### Where a Tool May Reach (Egress)

An `http` or `mcp` tool's target is bounded by the deployment, not the tool definition. Default: any publicly routable address. Loopback, `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` (cloud metadata), CGNAT and IPv6 ULA fail with `403 TOOL_EGRESS_BLOCKED`, the refused address in `meta.tool_address`.

The resolved address is checked on the first request and every redirect hop; credential headers (`Authorization`, `Cookie`) are dropped when a redirect changes origin. A public hostname resolving to `169.254.169.254` and a `302 Location: http://169.254.169.254/…` are both refused.

The operator allows internal services in [`TOOL_EGRESS_ALLOWED_HOSTS`](../self-hosting/configuration.md#outbound-egress), deployment-wide, not per project. For SOAT's own API use a [`builtin` tool](#builtin): in-process, under the caller's permissions.

### Calling a Tool Directly

[`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool) invokes a tool without an agent. Body: `action` (required for `builtin` and `mcp`; ignored for `pipeline`), `input` (the pipeline input for `pipeline`), `tool_context`. With an `output_mapping` the response is its result ([Output Mapping](#output-mapping)).

- A target neither publicly routable nor in `TOOL_EGRESS_ALLOWED_HOSTS` is `403 TOOL_EGRESS_BLOCKED` before any connection is opened — [Where a Tool May Reach](#where-a-tool-may-reach-egress).
- A non-2xx target response is `502 TOOL_HTTP_ERROR`; error `meta` carries `tool_status_code`, `tool_response_body`, `tool_url` and `tool_method`.
- [`execute.auth`](#computed-credentials-executeauth) failing to produce the credential is `502 TOOL_AUTH_FAILED`.
- A 2xx body that is not valid JSON is returned as raw text; an empty result (a `builtin` action answering `204`) is `200` with a JSON `null` body.
- `tool_context` reaches a tool declaring a [`{{context:<key>}}` token](#context-references-in-headers); with no session on this route, `session_id`, `actor_id` and `actor_external_id` are dropped — [Calling a context-dependent tool directly](../advanced/tool-context.md#calling-a-context-dependent-tool-directly).

## Examples

### Create an HTTP tool

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "get-weather" \
  --type http \
  --description "Fetches current weather for a city" \
  --execute '{"url":"https://api.weather.example/v1/current?city={city}","method":"GET"}' \
  --parameters '{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.tools.createTool({
  body: {
    project_id: 'proj_ABC',
    name: 'get-weather',
    type: 'http',
    description: 'Fetches current weather for a city',
    execute: {
      url: 'https://api.weather.example/v1/current?city={city}',
      method: 'GET',
    },
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/tools \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "get-weather",
    "type": "http",
    "description": "Fetches current weather for a city",
    "execute": {
      "url": "https://api.weather.example/v1/current?city={city}",
      "method": "GET"
    },
    "parameters": {
      "type": "object",
      "properties": { "city": { "type": "string" } },
      "required": ["city"]
    }
  }'
```

</TabItem>
</Tabs>

### Create a pipeline tool

Step one computes a sum, step two persists it, the first output mapped into the second input (`$CALC_TOOL_ID` and `$SAVE_TOOL_ID` are existing tool IDs).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "compute-and-save" \
  --type pipeline \
  --description "Computes a sum and persists the result" \
  --parameters '{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]}' \
  --pipeline '{"steps":[{"id":"compute","tool_id":"'"$CALC_TOOL_ID"'","action":"add","input":{"a":{"var":"input.x"},"b":{"var":"input.y"}}},{"id":"persist","tool_id":"'"$SAVE_TOOL_ID"'","input":{"value":{"var":"steps.compute.sum"}}}],"output":{"saved_id":{"var":"steps.persist.id"}}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.tools.createTool({
  body: {
    project_id: 'proj_ABC',
    name: 'compute-and-save',
    type: 'pipeline',
    description: 'Computes a sum and persists the result',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
    pipeline: {
      steps: [
        {
          id: 'compute',
          tool_id: 'tool_calc',
          action: 'add',
          input: { a: { var: 'input.x' }, b: { var: 'input.y' } },
        },
        {
          id: 'persist',
          tool_id: 'tool_save_record',
          input: { value: { var: 'steps.compute.sum' } },
        },
      ],
      output: { saved_id: { var: 'steps.persist.id' } },
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/tools \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "compute-and-save",
    "type": "pipeline",
    "parameters": {"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]},
    "pipeline": {
      "steps": [
        {"id":"compute","tool_id":"tool_calc","action":"add","input":{"a":{"var":"input.x"},"b":{"var":"input.y"}}},
        {"id":"persist","tool_id":"tool_save_record","input":{"value":{"var":"steps.compute.sum"}}}
      ],
      "output": {"saved_id":{"var":"steps.persist.id"}}
    }
  }'
```

</TabItem>
</Tabs>

### Call a tool directly

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat call-tool --tool-id "$TOOL_ID" --input '{"city":"São Paulo"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.tools.callTool({
  path: { tool_id: 'tool_abc' },
  body: { input: { city: 'São Paulo' } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/tools/tool_abc/call \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"input":{"city":"São Paulo"}}'
```

</TabItem>
</Tabs>
