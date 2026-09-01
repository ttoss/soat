---
description: "Standalone, reusable tool definitions that SOAT agents call during generation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Tools

Standalone, reusable tool definitions that agents call during generation.

## Overview

The Tools module lets you define callable tools that agents use during a generation loop. A tool encapsulates its type, input schema, and execution configuration in one project-scoped record. Tools can be shared across multiple agents and invoked directly via the API independently of any agent.

Five tool types are supported: `http` (calls an external HTTP endpoint), `client` (signals the calling application to execute locally), `mcp` (proxies an MCP server), `builtin` (invokes a SOAT platform action), and `pipeline` (runs a deterministic sequence of other tools as a single call). Any other `type` is rejected with `400 VALIDATION_FAILED` on create and update.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

To invoke a tool automatically, bind it to a [Trigger](./triggers.md) with `target_type: tool`. To classify a tool's calls and require human approval, attach a [Guardrail](./guardrails.md) — on the tool (governs it for every agent) or on the agent; decisions land in the [approval queue](./approvals.md).

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

HTTP header names in `execute.headers` and `mcp.headers` are opaque and preserved **verbatim** — SOAT does not case-transform them. `Authorization` round-trips as `Authorization`.

### Context Headers (`X-Soat-Context-*`)

On every `http` and `mcp` tool call, the server injects the generation's [`tool_context`](../advanced/tool-context.md) as `X-Soat-Context-*` request headers — including the auto-populated `sessionId`, `actorId` and `actorExternalId` — in addition to, and after, the headers you configure. This is how a tool endpoint learns who the agent is acting for without trusting the prompt; the prefix is deployment configuration ([`TOOL_CONTEXT_HEADER_PREFIX`](../self-hosting/configuration.md#agent-generation)), so a caller can never overwrite a tool's own credential. When a target needs a context value in a header of its own, declare it with a [`{{context:<key>}}` token](#context-references-in-headers). See the [Tool Context reference](../advanced/tool-context.md) for the key→header rule and security notes.

By default every context key reaches every `http`, `mcp` and `builtin` tool; set [`context_keys`](#scoping-which-context-keys-reach-a-tool) to bound that.

### Tool ID vs Tool Name

A **tool ID** is the resource identifier (e.g., `tool_k8x2f3np`), used in [`tool_bindings`](./agents.md#tool-bindings), `active_tool_ids`, and `step_rules[].active_tool_ids`. A **tool name** is what the AI model sees at runtime. For `http` and `client` tools, one ID → one name; for `mcp` and `builtin` tools, one ID exposes **many** names. `tool_choice` and `stop_conditions` on agents reference tools by **name**.

### Tool Name Resolution

| Tool type | Name the model sees    | Example                                              |
| --------- | ---------------------- | ---------------------------------------------------- |
| `http`    | `{name}`               | `search`                                             |
| `client`  | `{name}`               | `read_local_file`                                    |
| `mcp`     | `{name}_{mcpToolName}` | `github_create_issue`, `github_list_repos`           |
| `builtin`    | `{name}_{action}`      | `platform_get-document`, `platform_search-knowledge` |

For `mcp` and `builtin`, the tool's `name` is a **prefix** joined with an underscore to each discovered sub-tool name, guaranteeing uniqueness when two servers or action sets share a sub-tool name (e.g., `github_search` vs `jira_search`).

### http

When the model calls an `http` tool, the server sends an HTTP request to `execute.url` using the configured method. For `POST`, `PUT`, and `PATCH` the tool arguments are sent as a JSON body. For `GET`, `HEAD`, and `DELETE` the arguments become query-string parameters.

`execute.url` supports two placeholder syntaxes for injecting tool arguments into the URL path at invocation time; arguments consumed by either form are excluded from the request body or query string:

- **`{paramName}`** — replaced with the corresponding tool argument (URL-encoded). Use when defining the tool directly via the API or CLI.
- **`${body.fieldName}`** — same behavior, but used inside formation template `sub` expressions, where `${...}` is the interpolation syntax (e.g. `url: { sub: '${AppUrl}/posts/${body.post_id}' }`).

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

Never paste raw credentials into `execute.headers` — [`GET /tools/{id}`](/docs/api/tools/get-tool) echoes the config back verbatim to anyone with read access. Embed a [secret reference](./secrets.md#secret-references-secret) instead, e.g. `"headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" }`.

`{{secret:...}}` tokens are supported in `execute.url` and `execute.headers` values. The token is resolved to the decrypted secret value right before the outbound request; the stored tool — and everything returned by `GET`/`LIST` — keeps the reference. The referenced secret must exist in the same project, validated at tool create/update time (`400 SECRET_NOT_FOUND` otherwise).

Secret and [context](#context-references-in-headers) references are the **only** valid double-curly forms: any other `{{...}}` token anywhere in `execute` or `mcp` is rejected at create/update time with `400 INVALID_TEMPLATE_TOKEN` — use single braces (`{param}`) for [URL path placeholders](#http). See [Expressions & Templating](../advanced/expressions-and-templating.md) for the full pattern reference.

#### Context references in headers

A `{{context:<key>}}` token in `execute.headers` or `mcp.headers` is substituted, per call, with one key of the caller's [`tool_context`](../advanced/tool-context.md) — e.g. `"headers": { "Authorization": "Bearer {{context:ocaToken}}" }`. Use it when a per-user credential must reach the target in the header the target expects.

| | |
| --- | --- |
| Valid in | `execute.headers` and `mcp.headers` only. In `execute.url`, `mcp.url`, `execute.auth` or a body it is rejected with `400 INVALID_TEMPLATE_TOKEN` — a caller-supplied value must not be able to steer the outbound URL. |
| Missing key at call time | The call fails with `400 MISSING_TOOL_CONTEXT_KEY`, naming the key and header, rather than sending an empty credential. |
| Read back | `GET`/`LIST` echo the token, never the resolved value — same as `{{secret:...}}`. |
| Calling paths without context | [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool) and an orchestration `tool` node carry no `tool_context`, so a tool declaring this token cannot be invoked through them. Reach it through an agent generation, a session, or an orchestration `agent` node. |

#### Scoping which context keys reach a tool

A generation's `tool_context` is forwarded, in full, to every `http`, `mcp` and `builtin` tool the agent has. When one of those keys is a credential, `context_keys` bounds the egress per tool: with `"context_keys": ["tenant"]` and a caller sending `tool_context: { "ocaToken": "...", "tenant": "acme" }`, the tool receives `X-Soat-Context-tenant` and **not** `X-Soat-Context-ocaToken`.

| | |
| --- | --- |
| Omitted or `null` | Every key is forwarded. This is the default. |
| `[]` | No caller key is forwarded. |
| Identity keys | `sessionId`, `actorId` and `actorExternalId` are server-derived and always forwarded regardless of the list. |
| `{{context:<key>}}` tokens | Substituted regardless of the list: the tool declared that header itself. A key used only in a token need not be listed. |
| `builtin` tools | The list also bounds the `tool_context` propagated in the action's request body, so a nested generation inherits only the listed keys. |
| Matching | Case-insensitive (a key names a header). |
| Invalid entry | An entry outside the [key grammar](../advanced/tool-context.md) is rejected at write time with `400 INVALID_TOOL_CONTEXT_KEY`. |

The allowlist is per tool, not per agent: the same tool used by ten agents carries the same bound.

#### Computed credentials (`execute.auth`)

Some targets cannot be authenticated with a static header: AWS expects a per-request Signature Version 4 HMAC, and Google expects a short-lived OAuth 2.0 access token minted from a signed service account assertion. `execute.auth` fills that gap. It is an authentication strategy on the existing `http` transport, not a separate tool type: `parameters`, path placeholders, `body_mode`, `output_mapping`, `preset_parameters`, guardrails, approvals, pipeline steps and `502 TOOL_HTTP_ERROR` mapping all behave identically whether or not `auth` is set.

| `auth.type`             | Required fields                                                        | Optional fields | What is sent |
| ----------------------- | ---------------------------------------------------------------------- | --------------- | ------------ |
| `aws_sigv4`             | `region`, `service`, `access_key_id`, `secret_access_key`              | `session_token` | `Authorization: AWS4-HMAC-SHA256 …`, `X-Amz-Date`, plus `X-Amz-Security-Token` and `X-Amz-Content-Sha256` when applicable |
| `gcp_service_account`   | `credentials` (service account key file JSON, as a string), `scopes`    | —               | `Authorization: Bearer <access token>` |

Store credential values as [secret references](./secrets.md#secret-references-secret) — the reference is what is stored and returned, resolved only immediately before signing:

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

Behaviour worth knowing:

- **Signing happens last**, over the final method, URL, headers and body. Only headers SOAT itself controls are signed (`host`, `content-type`, `x-amz-*`); [context headers](#context-headers-x-soat-context-) and `Idempotency-Key` are sent unsigned, which AWS permits.
- **`aws_sigv4` is incompatible with `body_mode: "multipart"`** (`400 VALIDATION_FAILED` at create/update): the multipart body bytes are not knowable at signing time.
- **Path encoding follows the service** — segments are URI-encoded twice for every service except `s3` (single encoding), matching the SigV4 spec.
- **GCP tokens are cached** per service account, token endpoint and scope set, and refreshed shortly before expiry.
- **`service` and `region` are part of the signature**, not just routing — a mismatch produces a signature the target rejects.
- **Credential failures return `502 TOOL_AUTH_FAILED`** (distinct from `502 TOOL_HTTP_ERROR`, the target rejecting the call); when the token endpoint responded, its status and body are in the error `meta` as `upstream_status` and `upstream_body`.

Every field in `auth` is validated at create and update time (`400 VALIDATION_FAILED`), and the same rule runs during `validate-formation`.

#### Request body encoding (`body_mode`)

The `input` a caller passes to an `http` tool becomes its request body **verbatim** — SOAT does not case-transform the body keys. Author the input in whatever casing the target API expects; a tool's `input` is an opaque payload forwarded to the target, not a SOAT resource field.

For `POST`, `PUT`, and `PATCH`, the request body defaults to JSON (`Content-Type: application/json`). Set `execute.body_mode` to `"multipart"` for APIs that require `multipart/form-data`. In multipart mode:

- Scalar fields (string, number, boolean) become plain form fields.
- A field shaped like `{ content_type, filename, data_base64 }` — the shape an [ingestion rule](./ingestion-rules.md) passes for the uploaded file — is base64-decoded and attached as a file part with the given filename and content type.
- The `Content-Type` header is left unset so `fetch` generates the boundary itself (any `Content-Type` in `execute.headers` is dropped).

### client

Client tools have no server-side `execute`. When the model calls a `client` tool, the generation **pauses** — it suspends with `status: "requires_action"` and the pending tool calls. The caller executes the tool locally, then submits the results via [`POST /agents/{agent_id}/generate/{generation_id}/tool-outputs`](/docs/api/agents/submit-agent-tool-outputs) to resume the loop; the response is either a final result or another `requires_action` if the model calls more client tools.

Resuming continues the paused turn rather than starting one: the agent's [`tool_choice`](./agents.md#tool-choice) still applies, [`step_rules`](./agents.md#step-rules) keep counting from the turn's first step, and what remains of [`max_steps`](./agents.md#stop-conditions) is what the resumed loop has to spend — so a caller cannot extend one turn indefinitely by submitting outputs.

Example response when a client tool is called:

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

An `mcp` tool represents a connection to a [Model Context Protocol](https://modelcontextprotocol.io/) server. At generation time, the SOAT server connects to the MCP endpoint, discovers all available tools, and registers them with the AI model — one `mcp` tool ID provides **many** tool names, each with the name, description, and parameters the MCP server advertises. The SOAT server acts as a proxy: it forwards the model's tool call to the MCP server and feeds the result back into the loop.

`mcp.url` and `mcp.headers` values support [secret references](./secrets.md#secret-references-secret), resolved right before the MCP server is contacted, exactly like [`http` tool headers](#secret-references-in-execute). `mcp.headers` also supports [`{{context:<key>}}`](#context-references-in-headers).

#### Scoping an MCP tool to a subset of actions

By default an `mcp` tool exposes the **entire** MCP server surface. Set the `actions` array to an allowlist of MCP tool names to scope it:

```json
{
  "name": "oneclick",
  "type": "mcp",
  "mcp": { "url": "https://mcp.oneclick.example/sse" },
  "actions": ["list_campaigns", "get_campaign"]
}
```

The scope is enforced at two points: only allowlisted tools are registered with the model during generation, and [`POST /tools/{id}/call`](/docs/api/tools/call-tool) (and `pipeline` steps) reject an `action` outside the allowlist with `400 VALIDATION_FAILED` before any request reaches the MCP server.

Omit `actions` (or set `null`) to expose the whole surface; `[]` exposes nothing. Because MCP tool names are discovered at runtime, they are **not** validated against a static registry at create/update time (unlike `builtin` actions) — a name the server does not advertise is simply never exposed.

`denied_actions` is the inverse: expose the whole surface minus a denylist (useful for a read+write server where enumerating every read tool would drift). It is enforced at the same two points, applied **after** `actions`, and **takes precedence** over it: a name present in both is denied. Omit or `null` denies nothing.

### builtin

A `builtin` tool exposes actions from the SOAT platform itself (documents, conversations, files, secrets, etc.). Instead of pointing to an external endpoint, you list the platform actions the agent may use via the `actions` array. Each action name corresponds to an MCP tool registered on the platform (e.g., `get-document`, `search-knowledge`, `create-file`) — **not** the REST operationId (use `search-knowledge`, not `searchKnowledge`). For a worked example of a fixed `builtin` write tool, see [Orchestrate a Sonnet - Step 4 (Create the fixed write tool)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool).

Creating or updating a `builtin` tool validates every entry in `actions` against the platform's action registry. An unrecognized action name returns `400 VALIDATION_FAILED` immediately; a camelCase name matching a known action once kebab-cased gets a suggestion (e.g. `"searchKnowledge" (did you mean "search-knowledge"?)`).

A platform action that responds non-2xx **fails the tool call** — `502 TOOL_HTTP_ERROR`, with the real status in `meta.tool_status_code` — so a rejected or unauthorized action can't be mistaken for data. An action that answers `204 No Content` (every `delete-*`) yields a `null` result rather than an error.

An operation whose response cannot be a tool result is rejected at create time with `400 VALIDATION_FAILED`: `download-file` (raw bytes — use `download-file-base64`) and `export-audit-entries` (unbounded NDJSON — use `list-audit-entries`). Both remain available over REST, the SDK, and the CLI. For the same reason, `create-agent-generation` is callable as a `builtin` action but without `stream`, and returns the completed generation.

#### How a builtin action is executed

The action runs **in the server process**, dispatching through the same middleware stack and route handler a client request goes through — no network hop, so nothing depends on the server being reachable at a particular address. The route's permission check runs per call against the caller's policies, and strict field validation, audit logging, metering and quotas, and the snake_case response contract all apply exactly as for a client request.

A `builtin` tool therefore has **no ambient authority**: it acts with the credential it was given, and an action the credential cannot perform fails with `502 TOOL_HTTP_ERROR` / `meta.tool_status_code: 403`. A call that does not settle within `SOAT_TOOL_CALL_TIMEOUT_MS` (default `300000`) fails with a timeout error. Called from an orchestration, a `builtin` tool acts as the run's own identity — see [Run identity](./orchestrations.md#durable-background-execution).

When a `builtin` tool is called mid-turn by an agent, the server injects `tool_context`, `parent_trace_id`, `root_trace_id`, and `max_call_depth` into the request only for actions whose REST schema declares those fields (currently only `create-agent-generation`); other actions are called as-is.

### pipeline

A `pipeline` tool runs a **fixed, ordered sequence of other tools as a single call** — one tool call executes the whole `compute → persist` sequence deterministically server-side, with no model reasoning between steps. The same pipeline is callable by orchestration `tool` nodes and directly via the API.

The `pipeline` config has a `steps` array and an optional `output`:

- **`steps[]`** — each step calls a tool either by **`tool_id`** (an existing tool) or by an inline **`tool`** definition (the same shape as [Create Tool](#data-model) minus `project_id`, executed without a Tool row) — never both. An inline step `tool` cannot itself be of type `pipeline`. In a [formation](./formations.md) template, `tool_id` may be a `{ "ref": "ResourceName" }` reference to another tool resource in the same template, resolved at deploy time. Either form accepts an optional **`action`** for `builtin`/`mcp` step tools. The step's **`input`** is a mapping object whose values are [JSON Logic](https://jsonlogic.com) expressions evaluated against a `{ input, steps }` context:
  - `{ "var": "input.<field>" }` reads the pipeline tool's own input; `{ "var": "steps.<id>.<path>" }` reads an earlier step's output.
  - Literals pass through; transforms (`cat`, `+`, `if`, `map`, `filter`, `reduce`, …) are supported, and expressions are resolved **recursively at any nesting depth**.
  - A value is treated as an expression only when it is a single-key object whose key names a real JSON Logic operator. To pass a **literal** object that looks like one, wrap it in `preserve`, which returns its argument unevaluated: `{ "preserve": { "var": "some.var" } }`.
- **`output`** (optional) — a JSON Logic expression, evaluated the same way, that builds the return value. When omitted, the last step's raw output is returned. `output` may resolve to a bare scalar (e.g. `{ "var": "steps.<id>.<path>" }`) or an object with nested expressions.

Each step's full output is captured under `steps.<id>`. A step may reference only **earlier** steps — forward references are rejected at create time. Execution is **fail-fast**: the first failing step aborts the pipeline with `PIPELINE_STEP_FAILED`. A `tool_id` step targeting another `pipeline` tool is bounded by a maximum nesting depth (`PIPELINE_DEPTH_EXCEEDED`). Steps cannot target `client` tools, which cannot run server-side.

> **Case convention.** Structural keys are snake_case (`tool_id`, `steps`, `input`, `output`). A step's `input` mapping is a **tool payload, not a SOAT field**: its keys are preserved **verbatim** and become the sub-tool's arguments — author them in the exact casing the target expects. A `var` path must match the casing of the data it reads.

For LLM-decided (rather than fixed) multi-step flows, see [Orchestrations](./orchestrations.md), which share the same JSON Logic mapping model.

**Validation.** [`POST /tools`](/docs/api/tools/create-tool), [`PATCH /tools/:id`](/docs/api/tools/update-tool), and `validate-formation` all validate a `pipeline` config's structure before it can run — every step must have a `tool_id` or an inline `tool` object with a `name`. In a formation template a step `tool_id` may be a `{ "ref": … }` (resolved at deploy); direct `POST`/`PATCH` require a literal string `tool_id`. `validate-formation` additionally warns (not an error) when the tool's own `parameters` schema declares a property that no step `input` or `output` mapping ever reads via `{ "var": "input.<name>" }` — an unreachable input key.

### Output Mapping

`output_mapping` is a universal [JSON Logic](https://jsonlogic.com) mapping applied to a tool's raw result, for **every** tool type. It's evaluated over `{ "output": <raw result>, "input": <merged input> }`, so `{ "var": "output.text" }` extracts a bare scalar without needing a wrapping `pipeline` tool, and `{ "var": "input.title" }` echoes back a field of the request. An object mapping reshapes the result instead of extracting one field:

```json
{ "transcript": { "var": "output.text" }, "language": { "var": "output.language" } }
```

`input` is the tool's merged input for this call — the caller-supplied `input` with `preset_parameters` pinned over it.

- **Ordering for `pipeline` tools.** The tool's top-level `output_mapping` runs *after* the pipeline's own `output` mapping, over the pipeline's final result.
- **`client` tools.** The mapping is applied when the submitted tool output is materialized back into the generation, keyed by tool name.
- **Where `input` is available.** Populated for a direct call ([`POST /tools/{id}/call`](/docs/api/tools/call-tool)), a pipeline step, or a workflow/orchestration tool dispatch; `{}` for a tool the model calls by name from within an agent's loop, and for a `client` tool's output mapping.
- **A `var` path that resolves to `null`** (commonly a mismatched path, e.g. a missing `output.` prefix) emits a debug log entry; the mapped result is unchanged.

When no `output_mapping` is configured, the raw result is returned unchanged.

### Preset Parameters

`preset_parameters` bakes fixed values into a tool definition. When a key matches a field in the action's input schema, that field is **removed from the schema shown to the model** and the preset value is **merged into every call** before dispatch. This eliminates the risk of the model choosing a wrong value for parameters that should always be fixed, and enables multiple tool instances targeting different resources from the same action — e.g. two `builtin` tools both binding `update-document`, one with `"preset_parameters": { "id": "doc_abc123" }` and one with `{ "id": "doc_xyz789" }`. See it end to end in [Agent SOAT Tools and Preset Parameters - Step 6 (Create builtin tools)](/docs/tutorials/agent-soat-tools#step-6--create-builtin-tools).

**A preset is a pin, not a default: it wins.** If a call supplies a value for a
key the tool pins — a model that names the hidden field anyway, or an `input`
sent to [`POST /tools/{id}/call`](/docs/api/tools/call-tool) — the preset value
is what dispatches. Keys the presets do not name are taken from the call as
usual. Hiding the field from the schema is ergonomics, not the guarantee: no
tool schema sets `additionalProperties: false`, so a model that emits a hidden
key is not rejected, and the merge order is what makes a pinned parameter
actually fixed.

This holds on **every** tool type — `builtin`, `http`, `mcp`, `client`,
`pipeline` — and at every dispatch surface: an agent's tool loop, a direct call,
a pipeline step, an orchestration tool node, a converter invocation. A guardrail
evaluates the pinned arguments too (`args.*` in a guard condition, and the
`arguments` recorded on an approval item), since those are the arguments the
call will carry.

For a `client` tool the server never dispatches the call, so the presets are
applied to the arguments handed over at the `requires_action` boundary — what
your client receives is already pinned.

On an `mcp` binding, presets apply to **every** tool the MCP server exposes
through that binding, the same reach they have over every action a `builtin`
binding lists. Pin a key on a binding only when it is meant for all of them; use
a separate binding otherwise.

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

That is what lets one tool serve many tenants: the credential and the scope it must be confined to both come from the run, and neither is in the model's hands. A key missing from this call's `tool_context` fails the call with `400 MISSING_TOOL_CONTEXT_KEY` rather than sending the literal placeholder; a resolved value is retyped to the parameter's declared schema type, since context values are strings. `{{secret:...}}` is **not** resolved in a preset — it stays literal, so secrets remain a headers-only mechanism.

Presets and model-supplied arguments reach the action wherever the OpenAPI operation declares the parameter — path, query string, or request body. A `list-*` action's `project_id`, filters, and pagination arguments are query parameters, so a preset like `{ "project_id": "proj_abc123" }` is the way to lock a `builtin` tool to one project. An argument the caller omits is left out of the request entirely rather than sent as an empty value.

### Where a Tool May Reach (Egress)

An `http` or `mcp` tool is a request **the server makes**, so its target is
bounded by the deployment, not by the tool definition. The default is: any
publicly routable address, and nothing else. A target that is not — loopback,
`10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` (cloud metadata),
CGNAT, IPv6 ULA — fails with `403 TOOL_EGRESS_BLOCKED`, with the refused
address in `meta.tool_address`.

The address the hostname **resolves to** is what is checked, and the check runs
again on every redirect hop; credential headers (`Authorization`, `Cookie`) are
dropped when a redirect changes origin. So a public-looking hostname pointing at
`169.254.169.254`, and a legitimate target answering
`302 Location: http://169.254.169.254/…`, are both refused.

To reach an internal service on purpose, the operator lists it in
[`TOOL_EGRESS_ALLOWED_HOSTS`](../self-hosting/configuration.md#tool-egress) —
a deployment-wide setting, not a per-project one. When the destination is SOAT's
own API, use a [`builtin` tool](#builtin) instead of an `http` tool pointed at
your own base URL: it dispatches in-process under the caller's own permissions
and never leaves the network.

### Calling a Tool Directly

Tools can be invoked independently of an agent via [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool). The body accepts `action` (required for `builtin` and `mcp` types) and `input`. For `pipeline` tools, `input` is the pipeline input and `action` is ignored. When the tool has an `output_mapping`, the response is that mapping's result — see [Output Mapping](#output-mapping).

- A target that is not publicly routable, and not listed in the deployment's `TOOL_EGRESS_ALLOWED_HOSTS`, fails with `403 TOOL_EGRESS_BLOCKED` before any connection is opened — see [Where a Tool May Reach](#where-a-tool-may-reach-egress).
- A non-2xx target response fails with `502 TOOL_HTTP_ERROR`; the error `meta` carries `tool_status_code`, `tool_response_body`, `tool_url`, and `tool_method`.
- If [`execute.auth`](#computed-credentials-executeauth) cannot produce the credential, the call fails with `502 TOOL_AUTH_FAILED` instead.
- A 2xx response whose body isn't valid JSON is returned as raw text; an empty result (e.g. a `builtin` action answering `204`) responds `200` with a JSON `null` body.
- This endpoint carries no [`tool_context`](../advanced/tool-context.md), so a tool declaring a [`{{context:<key>}}` token](#context-references-in-headers) fails here with `400 MISSING_TOOL_CONTEXT_KEY` — reach it through an agent.

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

A `pipeline` tool chains existing tools: here one step computes a sum, the next persists it, mapping the first step's output into the second step's input (`$CALC_TOOL_ID` and `$SAVE_TOOL_ID` are IDs of previously created tools).

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
