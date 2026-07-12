import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Tools

Standalone, reusable tool definitions that agents call during generation.

## Overview

The Tools module lets you define callable tools that agents use during a generation loop. A tool encapsulates its type, input schema, and execution configuration in one project-scoped record. Tools can be shared across multiple agents and invoked directly via the API independently of any agent.

Six tool types are supported: `http` (calls an external HTTP endpoint), `client` (signals the calling application to execute locally), `mcp` (proxies an MCP server), `soat` (invokes a SOAT platform action), `pipeline` (runs a deterministic sequence of other tools as a single call), and `discussion` (invokes a [Discussion](./discussions.md) — the way an agent thinks mid-loop).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

To invoke a tool automatically — on a cron schedule, from an inbound webhook, or on demand — bind it to a [Trigger](./triggers.md) with `target_type: tool`.

## Related Tutorials

- [Agent SOAT Tools and Preset Parameters - Step 6 (Create soat tools)](/docs/tutorials/agent-soat-tools#step-6--create-soat-tools)
- [Orchestrate a Sonnet - Step 4 (Create the fixed write tool)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 5 (Create fixed SOAT tools)](/docs/tutorials/multi-agent-orchestration#step-5--create-fixed-soat-tools-for-stanza-agents)
- [Agent over a Library of PDFs - Step 12 (Give the agent a knowledge tool)](/docs/tutorials/agent-with-pdfs#step-12--give-the-agent-a-knowledge-tool-plan-d)

## Data Model

| Field               | Type                                            | Description                                                                                                       |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                | `string`                                        | Public ID (`tool_` prefix)                                                                                        |
| `project_id`        | `string`                                        | ID of the owning project                                                                                          |
| `name`              | `string`                                        | Machine-readable tool name sent to the model (or namespace prefix for `mcp`/`soat`)                               |
| `type`              | `"http"` \| `"client"` \| `"mcp"` \| `"soat"` \| `"pipeline"` \| `"discussion"` | Tool type — determines execution behaviour                                        |
| `description`       | `string \| null`                                | Human-readable description sent to the model for tool selection                                                   |
| `parameters`        | `object \| null`                                | JSON Schema describing the tool's input. Required for `http` and `client` types.                                  |
| `execute`           | `object \| null`                                | HTTP execution config (`url`, `method`, `headers`, `body_mode`). Required for `http` type.                        |
| `execute.url`       | `string`                                        | HTTP endpoint. Supports `{paramName}` and `${body.fieldName}` path placeholders replaced at call time with URL-encoded argument values.   |
| `execute.method`    | `string`                                        | HTTP method (default: `POST`). For `GET`, `HEAD`, `DELETE` the arguments become query-string parameters.          |
| `execute.headers`   | `object`                                        | Additional headers sent with the execution request.                                                               |
| `execute.body_mode` | `"json" \| "multipart"`                         | How the request body is encoded for `POST`/`PUT`/`PATCH` (default: `json`). Use `multipart` for APIs that require `multipart/form-data`. |
| `mcp`               | `object \| null`                                | MCP server config (`url`, `headers`). Required for `mcp` type.                                                    |
| `mcp.url`           | `string`                                        | URL of the MCP server (SSE or Streamable HTTP transport).                                                         |
| `mcp.headers`       | `object`                                        | Additional headers sent when connecting to the MCP server.                                                        |
| `actions`           | `string[] \| null`                              | Allowlist of actions to expose. `soat`: SOAT platform action names, e.g. `["search-knowledge"]` (required). `mcp`: optional allowlist of MCP tool names to scope the server surface — `null` exposes every tool. See [mcp action scoping](#scoping-an-mcp-tool-to-a-subset-of-actions). |
| `preset_parameters` | `object \| null`                                | Fixed parameter values merged into every call. Keys are hidden from the model and injected automatically.         |
| `pipeline`          | `object \| null`                                | Pipeline definition (`steps`, optional `output`). Required for `pipeline` type. See [pipeline](#pipeline).         |
| `discussion_id`     | `string \| null`                                | ID of the discussion to invoke. Required for `discussion` type. See [discussion](#discussion).                    |
| `output_mapping`    | `object \| null`                                | JSON Logic mapping applied to the tool's raw result, for every tool type. See [output mapping](#output-mapping).   |
| `created_at`        | `string`                                        | ISO 8601 creation timestamp                                                                                       |
| `updated_at`        | `string`                                        | ISO 8601 last-updated timestamp                                                                                   |

## Key Concepts

### Header Name Casing

HTTP header names in `execute.headers` and `mcp.headers` are opaque and preserved **verbatim** — SOAT does not case-transform them. `{ "headers": { "Authorization": "Bearer …" } }` round-trips as `Authorization`, not `authorization` or any snake_cased variant.

### Tool ID vs Tool Name

A **tool ID** is the auto-generated resource identifier (e.g., `tool_k8x2f3np`). It is used when attaching tools to agents via `tool_ids`, `active_tool_ids`, and `step_rules[].active_tool_ids`.

A **tool name** is the name the AI model sees at runtime (e.g., `"search"`). For `http` and `client` tools, one tool ID → one tool name (the `name` field). For `mcp` and `soat` tools, one tool ID exposes **many** tool names discovered from the MCP server or the platform's action registry.

`tool_choice` and `stop_conditions` on agents reference tools by **name** (not by ID).

### Tool Name Resolution

| Tool type | Name the model sees    | Example                                              |
| --------- | ---------------------- | ---------------------------------------------------- |
| `http`    | `{name}`               | `search`                                             |
| `client`  | `{name}`               | `read_local_file`                                    |
| `mcp`     | `{name}_{mcpToolName}` | `github_create_issue`, `github_list_repos`           |
| `soat`    | `{name}_{action}`      | `platform_get-document`, `platform_search-knowledge` |

For `http` and `client`, the `name` field maps directly to the tool name the model calls.

For `mcp` and `soat`, the tool's `name` is a **prefix** joined with an underscore to each discovered sub-tool name. This guarantees uniqueness when two MCP servers or action sets share the same sub-tool name (e.g., `github_search` vs `jira_search`).

### http

When the model calls an `http` tool, the server sends an HTTP request to `execute.url` using the configured method. For `POST`, `PUT`, and `PATCH` the tool arguments are sent as a JSON body. For `GET`, `HEAD`, and `DELETE` the arguments become query-string parameters.

`execute.url` supports two placeholder syntaxes for injecting tool arguments into the URL path at invocation time:

- **`{paramName}`** — replaced with the corresponding tool argument (URL-encoded). Use this syntax when the tool is defined directly via the API or CLI.
- **`${body.fieldName}`** — same behavior, but used inside formation template `sub` expressions where `${...}` is the interpolation syntax. Arguments consumed by either placeholder form are excluded from the request body or query string.

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

When the model calls this tool with `{ "user_id": "123", "post_id": "456" }`, the server issues:

```
DELETE https://api.example.com/users/123/posts/456
```

In a formation template, use `${body.fieldName}` inside a `sub` expression to interpolate tool arguments into the URL path:

```yaml
parameters:
  AppUrl:
    type: string
    default: 'https://api.example.com'
resources:
  PatchExpense:
    type: tool
    properties:
      type: http
      name: patch-recurring-expense
      execute:
        url: { sub: '${AppUrl}/finance/recurring-expenses/${body.publicUuid}' }
        method: PATCH
      parameters:
        type: object
        properties:
          publicUuid: { type: string }
          amount: { type: number }
        required: [publicUuid]
```

When called with `{ "publicUuid": "exp_abc", "amount": 42 }`, the server issues:

```
PATCH https://api.example.com/finance/recurring-expenses/exp_abc
Body: { "amount": 42 }
```

#### Secret references in `execute`

Never paste raw credentials into `execute.headers` — `GET /tools/{id}` echoes the config back verbatim to anyone with read access. Embed a [secret reference](./secrets.md#secret-references-secret) instead:

```json
{
  "name": "convert-document",
  "type": "http",
  "execute": {
    "url": "https://api.example.com/convert",
    "method": "POST",
    "headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" }
  }
}
```

`{{secret:...}}` tokens are supported in `execute.url` (e.g. for APIs that take a key as a query parameter) and in `execute.headers` values. The token is resolved to the decrypted secret value right before the outbound request; the stored tool — and everything returned by `GET`/`LIST` — keeps the reference. The referenced secret must exist in the same project, validated at tool create/update time (`400 SECRET_NOT_FOUND` otherwise).

#### Request body encoding (`body_mode`)

The `input` a caller passes to an `http` tool becomes its request body **verbatim** — SOAT does not case-transform the body keys, so `{ "input": { "fundamental_truth": "…" } }` is sent as `{"fundamental_truth":"…"}`, not `{"fundamentalTruth":"…"}`. Author the input in whatever casing the target API expects. (Elsewhere the REST API converts request bodies from snake_case to camelCase internally; a tool's `input` is exempt, because it is an opaque payload forwarded to the target, not a SOAT resource field.)

For `POST`, `PUT`, and `PATCH`, the request body defaults to JSON (`Content-Type: application/json`). Set `execute.body_mode` to `"multipart"` for APIs that require `multipart/form-data` (many audio, OCR, and file-upload endpoints reject JSON outright). In multipart mode:

- Scalar fields (string, number, boolean) become plain form fields.
- A field shaped like `{ content_type, filename, data_base64 }` — the shape an [ingestion rule](./ingestion-rules.md) passes for the uploaded file — is base64-decoded and attached as a file part with the given filename and content type.
- The `Content-Type` header is left unset so `fetch` generates the `multipart/form-data` boundary itself (any `Content-Type` in `execute.headers` is dropped).

```json
{
  "name": "transcribe-audio",
  "type": "http",
  "execute": {
    "url": "https://api.x.ai/v1/stt",
    "method": "POST",
    "body_mode": "multipart",
    "headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" }
  },
  "parameters": {
    "type": "object",
    "properties": {
      "model": { "type": "string" },
      "file": { "type": "object" }
    }
  }
}
```

When called with `{ "model": "grok-stt", "file": { "filename": "audio.mp3", "content_type": "audio/mpeg", "data_base64": "..." } }`, the server sends a `multipart/form-data` request with a `model` text field and a decoded binary `file` part.

### client

Client tools have no server-side `execute`. When the model calls a `client` tool, the generation **pauses** and returns the pending tool calls to the API caller. The caller executes the tool locally, then submits the results via `POST /agents/{agent_id}/generate/{generation_id}/tool-outputs` to resume the loop.

Client tool flow:

1. Caller starts a generation (`POST /agents/{agent_id}/generate`).
2. Agent loop runs normally — `http` tools execute on the server.
3. When the model calls a `client` tool, generation **suspends** with `status: "requires_action"` and the pending tool calls.
4. Caller inspects the tool calls, executes them locally, and submits results via `POST /agents/{agent_id}/generate/{generation_id}/tool-outputs`.
5. The server resumes the loop, feeding the submitted results back to the model.
6. Steps 2–5 repeat until the loop terminates.

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

The response has the same shape as a normal generation — either a final result or another `requires_action` if the model calls more client tools.

### mcp

An `mcp` tool represents a connection to a [Model Context Protocol](https://modelcontextprotocol.io/) server. At generation time, the SOAT server connects to the MCP endpoint, discovers all available tools, and registers them with the AI model. One `mcp` tool ID provides **many** tool names — you configure only the connection; each discovered tool's name, description, and parameters come from the MCP server.

The SOAT server acts as a proxy: it receives the model's tool call, forwards it to the MCP server, and feeds the result back into the loop.

`mcp.url` and `mcp.headers` values support [secret references](./secrets.md#secret-references-secret) — e.g. `{"Authorization": "Bearer {{secret:sec_01HXYZ}}"}` — resolved right before the MCP server is contacted, exactly like [`http` tool headers](#secret-references-in-execute).

#### Scoping an MCP tool to a subset of actions

By default an `mcp` tool exposes the **entire** MCP server surface: every tool the server advertises via `tools/list` is registered with the model. For a read+write server this makes a "read-only" role unenforceable at the capability level — the write tools are always present, and the boundary rests on the prompt alone.

Set the `actions` array to an allowlist of MCP tool names to scope the tool to just those:

```json
{
  "name": "oneclick",
  "type": "mcp",
  "mcp": { "url": "https://mcp.oneclick.example/sse" },
  "actions": ["list_campaigns", "get_campaign"]
}
```

With `actions` set, the scope is enforced at two points:

- **Model surface** — only allowlisted tools are registered during generation. The model never sees, and cannot call, a tool outside the list.
- **Direct calls** — `POST /tools/{id}/call` (and `pipeline` steps) reject an `action` outside the allowlist with `400 VALIDATION_FAILED` ("not available on this tool") before any request reaches the MCP server.

`actions` is an **allowlist**, not a denylist: names not listed are excluded. Omit the field (or set it to `null`) to expose the whole server surface (the default). An empty array (`[]`) exposes nothing. Because MCP tool names are discovered at runtime from the remote server, they are **not** validated against a static registry at create/update time (unlike `soat` actions) — a name that the server does not advertise is simply never exposed.

### soat

A `soat` tool exposes actions from the SOAT platform itself (documents, conversations, files, secrets, etc.). Instead of pointing to an external endpoint, you list the platform actions the agent is allowed to use via the `actions` array. Each action name corresponds to an MCP tool registered on the platform (e.g., `get-document`, `search-knowledge`, `create-file`) — **not** the REST operationId (e.g. use `search-knowledge`, not `searchKnowledge`). The server executes these actions in-process, applying the same permission checks as the REST API. For a worked example of a fixed `soat` write tool, see [Orchestrate a Sonnet - Step 4 (Create the fixed write tool)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool).

Creating or updating a `soat` tool validates every entry in `actions` against the platform's action registry. An unrecognized action name returns `400 VALIDATION_FAILED` immediately; if the name looks like an operationId (camelCase) that matches a known action once converted to kebab-case, the error message includes a suggestion (e.g. `"searchKnowledge" (did you mean "search-knowledge"?)`).

When a `soat` tool is called mid-turn by an agent, the server injects `tool_context`, `parent_trace_id`, `root_trace_id`, and `max_call_depth` into the request only for actions whose REST schema declares those fields (currently only `create-agent-generation`, for nested agent-to-agent calls). Actions with no such fields — e.g. `search-knowledge` — are called as-is, so this bookkeeping never leaks into their request body as an unknown field.

### pipeline

A `pipeline` tool runs a **fixed, ordered sequence of other tools as a single call**, so an agent makes one tool call and the whole `compute → persist` sequence executes deterministically server-side — with no model reasoning between steps. The same pipeline is callable by orchestration `tool` nodes and directly via the API, so it is reusable wherever a tool is.

The `pipeline` config has a `steps` array and an optional `output`:

- **`steps[]`** — each step calls a tool either by **`tool_id`** (an existing, persisted tool) or by an inline **`tool`** definition — the same shape as [Create Tool](#data-model) minus `project_id`, executed directly without a Tool row — never both. An inline step `tool` cannot itself be of type `pipeline`. In a [formation](./formations.md) template, `tool_id` may also be a `{ "ref": "ResourceName" }` reference to another tool resource in the same template; it is resolved to that tool's physical id at deploy time (and the referenced tool is created first). Either form accepts an optional **`action`** for `soat`/`mcp` step tools. The step's **`input`** is a mapping object whose values are [JSON Logic](https://jsonlogic.com) expressions evaluated against a `{ input, steps }` context:
  - `{ "var": "input.<field>" }` reads the pipeline tool's own input.
  - `{ "var": "steps.<id>.<path>" }` reads an earlier step's output.
  - Literals pass through; transforms (`cat`, `+`, `if`, `map`, `filter`, `reduce`, …) are supported.
  - Expressions are resolved **recursively at any nesting depth** — a `var` (or any other operator) buried inside a plain object or array, such as `data.title` below, is evaluated just like a top-level one:
    ```json
    {
      "locale": "pt-BR",
      "data": {
        "title": { "var": "input.title" },
        "theme": { "var": "input.theme" }
      }
    }
    ```
  - A value is treated as an expression only when it is a single-key object whose key names a real JSON Logic operator (`var`, `cat`, `if`, …). To pass a **literal** object that happens to look like one — e.g. the actual JSON Logic object `{ "var": "some.var" }` as data, not as an expression — wrap it in `preserve`, which returns its argument unevaluated: `{ "preserve": { "var": "some.var" } }`.
- **`output`** (optional) — a [JSON Logic](https://jsonlogic.com) expression, evaluated the same way as a step's `input`, that builds the return value. When omitted, the last step's raw output is returned. `output` is also checked as a whole for being a single expression before falling back to per-key evaluation, so it can resolve to a bare scalar (not just an object):
  - `{ "var": "steps.<id>.<path>" }` returns that field's value directly, e.g. a bare string.
  - `{ "<key>": { "var": "steps.<id>.<path>" } }` returns an object, resolving the expression nested under `<key>`.

Each step's full output is captured under `steps.<id>`. A step may reference only **earlier** steps — forward references are rejected at create time — which keeps the sequence linear and deterministic. Execution is **fail-fast**: the first failing step aborts the pipeline with `PIPELINE_STEP_FAILED`. A `tool_id` step that targets another `pipeline` tool is bounded by a maximum nesting depth (`PIPELINE_DEPTH_EXCEEDED`); an inline `tool` step cannot be of type `pipeline` at all (no nested ephemeral pipelines). Steps cannot target `client` tools, which cannot run server-side.

> **Case convention.** Structural keys are snake_case (`tool_id`, `steps`, `input`, `output`). A step's `input` mapping is a **tool payload, not a SOAT field**: its keys are preserved **verbatim** — SOAT does not case-transform them — and become the sub-tool's arguments (for an `http` step, the literal request-body keys). Author them in the exact casing the target expects (e.g. `{ "fundamental_truth": … }` for a snake_case API). A `var` path must match the casing of the data it reads: `{ "var": "input.<field>" }` matches your tool's own `parameters` property names, and `{ "var": "steps.<id>.<field>" }` matches the upstream step's output.

For LLM-decided (rather than fixed) multi-step flows, see [Orchestrations](./orchestrations.md), which share the same JSON Logic mapping model.

**Validation.** `POST /tools`, `PATCH /tools/:id`, and `validate-formation` all validate a `pipeline` config's structure before it can run — including that every step has a `tool_id`/inline `tool` and that an inline step `tool` is an object with a `name` (missing it is reported immediately as an error, instead of surfacing only as a runtime failure the first time the pipeline executes). In a formation template a step `tool_id` may be a `{ "ref": … }` reference (resolved at deploy); `validate-formation` accepts it and, as for any ref, reports an error if the referenced resource is not declared in the template. Direct `POST /tools` / `PATCH /tools/:id` still require a literal string `tool_id` (there is nothing to resolve outside a formation). `validate-formation` additionally warns (not an error) when the tool's own `parameters` schema declares a property that no step's `input` mapping, and no `output` mapping, ever reads via `{ "var": "input.<name>" }` — such a caller-supplied value never reaches a step, so it is reported as an unreachable input key rather than being silently dropped.

### discussion

A `discussion` tool invokes a [Discussion](./discussions.md) — the way an agent thinks mid-loop. It references a discussion config by ID:

```json
{
  "name": "ask-the-panel",
  "type": "discussion",
  "parameters": {
    "type": "object",
    "properties": { "topic": { "type": "string" } },
    "required": ["topic"]
  },
  "discussion_id": "disc_V1StGXR8Z5jdHi6B"
}
```

When the model calls it with a `topic`, the server runs the discussion synchronously (bounded by the discussion's caps and timeouts, the same profile as a nested `create-agent-generation`) and returns `{ outcome, run_id }` as the tool result. The full transcript and outcome persist on the [run](./discussions.md#discussionrun); only the synthesized `outcome` re-enters the caller's context. The referenced discussion must belong to the tool's project. `discussion` tools cannot be defined inline on an agent — create a persisted discussion tool and reference it by `tool_id`.

### Output Mapping

`output_mapping` is a universal [JSON Logic](https://jsonlogic.com) mapping applied to a tool's raw result, for **every** tool type (`http`, `mcp`, `soat`, `pipeline`, `client`). It's evaluated over `{ "output": <raw result> }`, so `{ "var": "output.text" }` extracts a bare scalar field without needing a wrapping `pipeline` tool just to reshape a response:

```json
{
  "type": "http",
  "execute": { "url": "https://api.x.ai/v1/stt", "method": "POST", "body_mode": "multipart" },
  "output_mapping": { "var": "output.text" }
}
```

An object mapping reshapes the result instead of extracting a single field, the same way pipeline `output` does:

```json
{ "transcript": { "var": "output.text" }, "language": { "var": "output.language" } }
```

**Ordering for `pipeline` tools.** A pipeline already has its own `output` mapping over the pipeline's internal `steps.*` context. The tool's top-level `output_mapping` runs *after* that — over the pipeline's final result, wrapped as `{ "output": <pipeline result> }`. In practice a pipeline author can do all the reshaping in `output` directly, but `output_mapping` composes on top when needed (e.g. a shared pipeline tool whose result a specific caller wants to reshape further).

**`client` tools.** Since client tools are executed by the calling application rather than resolved server-side, `output_mapping` is applied when the submitted tool output is materialized back into the generation, keyed by tool name.

When no `output_mapping` is configured, a tool's raw result is returned unchanged.

### Preset Parameters

`preset_parameters` lets you bake fixed values into a `soat` (or any) tool definition. When a key in `preset_parameters` matches a field in the action's input schema:

1. That field is **removed from the schema shown to the model** — the model never sees or fills it in.
2. The preset value is **merged into every call** before the request is dispatched.

This eliminates the probabilistic risk of the model choosing a wrong value for parameters that should always be fixed (e.g., the ID of a specific document). It also enables creating multiple tool instances targeting different resources from the same action. See it end to end in [Agent SOAT Tools and Preset Parameters - Step 6 (Create soat tools)](/docs/tutorials/agent-soat-tools#step-6--create-soat-tools).

Example — two tools backed by the same `update-document` action, each locked to a different document:

```json
{
  "name": "public_doc",
  "type": "soat",
  "actions": ["update-document"],
  "preset_parameters": { "id": "doc_abc123" }
}
```

```json
{
  "name": "private_doc",
  "type": "soat",
  "actions": ["update-document"],
  "preset_parameters": { "id": "doc_xyz789" }
}
```

The model calls `public_doc_update-document` with only the fields it needs to supply (e.g., `content`). The server automatically injects `id: "doc_abc123"` before executing the request.

### Calling a Tool Directly

Tools can be invoked independently of an agent via `POST /api/v1/tools/{tool_id}/call`. The request body accepts `action` (required for `soat` and `mcp` types) and `input` (key-value arguments). For `pipeline` tools, `input` is the pipeline input, `action` is ignored, and the response is the mapped `output`. When the tool has an `output_mapping`, the response is that mapping's result instead of the raw output — see [Output Mapping](#output-mapping).

If an `http` tool's target responds with a non-2xx status, the call fails with `502 TOOL_HTTP_ERROR` instead of the target's own status code. The error `meta` carries the real upstream response: `tool_status_code`, `tool_response_body`, `tool_url`, and `tool_method`.

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

### Create a SOAT tool with preset parameters

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "docs-search" \
  --type soat \
  --description "Searches the project knowledge base" \
  --actions '["search-knowledge"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.tools.createTool({
  body: {
    project_id: 'proj_ABC',
    name: 'docs-search',
    type: 'soat',
    description: 'Searches the project knowledge base',
    actions: ['search-knowledge'],
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
    "name": "docs-search",
    "type": "soat",
    "description": "Searches the project knowledge base",
    "actions": ["search-knowledge"]
  }'
```

</TabItem>
</Tabs>

### Create a pipeline tool

A `pipeline` tool chains existing tools. This example computes a value with one tool, then persists it with another, mapping the first step's output into the second step's input (`$CALC_TOOL_ID` and `$SAVE_TOOL_ID` are IDs of previously created tools).

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
