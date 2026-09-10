---
description: "Complete reference for SOAT's six expression and templating pattern families and how each resolves at a different time so they compose without escaping."
---

# Expressions & Templating

Every place SOAT maps, transforms, or interpolates values uses one of six pattern families. Each has a distinct syntax because each resolves at a **different time**, which lets them compose in one string without escaping rules.

## Quick Reference

| Pattern | Syntax | Where it is valid | Resolves at |
| ------- | ------ | ----------------- | ----------- |
| [JSON Logic](#json-logic) | `{"var": "input.x"}`, `{"cat": [...]}`, `{"if": [...]}`, … | Orchestration `input_mapping`, `state_mapping`, `expression`, `exit_condition`; pipeline step `input` and pipeline `output`; tool `output_mapping` | Run / call time |
| [Dotted paths](#dotted-paths) | `state.a.b`, `text`, `MySecret.value` | Orchestration `state_mapping` keys, loop `collection`, and the `nodes.<id>` namespace; `output_path` on `tool_output` message content; formation `ref_attr` | Run / call / apply time |
| [`{param}`](#single-curly-param) | `/users/{user_id}` | `execute.url` of `http` tools | Call time |
| [`{{secret:...}}`](#secret-references-secret) | `{{secret:sec_01HXYZ}}` | `execute.url`, `execute.headers`, `mcp.url`, `mcp.headers` | Call time |
| [`{{context:...}}`](#context-references-context) | `{{context:ocaToken}}` | `execute.headers`, `mcp.headers`, `preset_parameters` | Call time |
| [`${...}`](#dollar-curly-formations-and-body-params) | `${ParamName}`, `${LogicalId}`, `${body.field}` | Formation `sub` expressions; `execute.url` | Apply time (`${Name}`) / call time (`${body.x}`) |
| [Formation objects](#formation-object-expressions) | `{"ref": ...}`, `{"param": ...}`, `{"sub": ...}` | Formation template resource properties | Apply time |

## JSON Logic

[JSON Logic](https://jsonlogic.com) is the single expression language for structured data mapping; one shared evaluator serves every surface.

An expression is a **single-key object whose key is a registered operator** (`var`, `cat`, `if`, comparison and arithmetic operators, `map`, …). Anything else is a literal: multi-key objects, arrays, and primitives are recursed into, so expressions nest at any depth inside literal structure.

```json
{
  "prompt": { "cat": ["Summarize: ", { "var": "input.text" }] },
  "isLong": { ">": [{ "var": "input.word_count" }, 500] },
  "data": { "title": { "var": "input.title" }, "static": "literal string" }
}
```

### Where each surface points `var`

Only the **context root** differs:

| Surface | Field | `var` reads from |
| ------- | ----- | ---------------- |
| Orchestration node | `input_mapping` | Run state. Run input is seeded under the `input` namespace only — read it with `{"var": "input.key"}` (a flat `{"var": "key"}` is never satisfied by run input). Every upstream node's raw artifact is also available under `nodes.<nodeId>` (see [Dotted paths](#dotted-paths)). |
| Orchestration `transform` / `condition` | `expression` | Run state (same as above) |
| Orchestration `poll` | `exit_condition` | Run state plus `response` (latest tool result) and `attempt` |
| Orchestration node | `state_mapping` | `{ "output": <the node's own artifact>, "state": <run state> }` — a different context root from every other orchestration surface |
| Pipeline tool step | `input` | `input.*` (tool call arguments) and `steps.<id>.*` (earlier step results) |
| Pipeline tool | `output` | Same as pipeline step `input` |
| Any tool (`http`, `mcp`, `pipeline`) | `output_mapping` | `output.*` (the tool's raw result) |

### Passing logic-shaped data as a literal

To pass an object that looks like an expression (for example the literal payload `{"var": "x"}`), wrap it in `preserve`, which returns its argument unevaluated:

```json
{ "payload": { "preserve": { "var": "x" } } }
```

## Dotted paths

Plain dotted strings appear where a value is an **address**, not an expression:

- **Orchestration `state_mapping` keys** — `{"state.summary": {"var": "output.content"}}` writes the node artifact's `content` field to `state.summary`, building nested objects along the way (`state.a.b` is readable back as `{"var": "a.b"}`). The `state.` prefix is optional. Keys are state write paths; values are [JSON Logic](#json-logic) — the reverse of `input_mapping`, where keys are input-parameter names and values point at the read source.
- **The `nodes.<id>` namespace** — every completed orchestration node's full artifact is recorded at `state.nodes.<nodeId>`, whether or not that node declares a `state_mapping`. A downstream node reads it with `{"var": "nodes.<nodeId>.<field>"}`, like a pipeline's `steps.<id>`. `nodes` is a reserved state key: a `state_mapping` write targeting it is rejected. An `input_schema` property named `nodes` is fine, since run input lives under `state.input`.
- **Loop node `collection`** — `state.items.pending` names the state array to iterate.
- **`output_path` on `tool_output` message content** — extracts a field from a tool result before it enters a conversation (`"text"`, `"data.0.url"`; numeric segments index arrays).
- **Formation `ref_attr`** — `"MySecret.value"` reads an attribute of another resource: everything before the first dot is the logical ID, the rest is the attribute name.

:::note[Mapping keys are stored verbatim]

The keys of an `input_mapping`, `state_mapping`, or approval-node `arguments` leave SOAT exactly as written — as a sub-tool's request-body key, an `emit_event` node's `data` key, or a line in the prompt an agent node builds. They are never case-converted: a key written `cost_center` arrives as `cost_center`, and any `{"var": ...}` that reads it keeps the same spelling.

:::

Dotted paths also appear inside JSON Logic `var` strings (`{"var": "steps.call.text"}`, `{"var": "nodes.fetch.result"}`); that is JSON Logic's addressing, not a separate mechanism.

## Single curly (`{param}`)

`execute.url` on `http` tools supports `{paramName}` placeholders, replaced at call time with the URL-encoded tool argument of the same name. Matched arguments are removed from the query/body; the rest pass through normally.

```json
{ "execute": { "url": "https://api.example.com/users/{user_id}/posts/{post_id}", "method": "DELETE" } }
```

This matches OpenAPI path templating.

:::warning[Single braces, not double]
`{{city}}` is **not** a supported placeholder — double braces are reserved for [secret](#secret-references-secret) and [context](#context-references-context) references. Creating or updating a tool (directly, or via a formation) with any other `{{...}}` token in `execute`/`mcp` fields is rejected with `400 INVALID_TEMPLATE_TOKEN`. Always write `{city}`.
:::

## Secret references (`{{secret:...}}`)

A `{{secret:sec_...}}` token embeds a [Secret](../modules/secrets.md) by public ID inside `execute.url`, `execute.headers`, `mcp.url`, or `mcp.headers`:

```json
{ "execute": { "headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" } } }
```

The secret must exist in the same project (validated at tool create/update; `400 SECRET_NOT_FOUND` otherwise). The stored tool and every `GET`/`LIST` response keep the token; the decrypted value is substituted server-side only in the outbound request and never echoed back.

## Context references (`{{context:...}}`)

A `{{context:<key>}}` token reads one key of the caller's [`tool_context`](./tool-context.md) for **this call** and substitutes it into a tool header, or into a pinned parameter:

```json
{ "mcp": { "headers": { "Authorization": "Bearer {{context:ocaToken}}" } } }
```

```json
{ "preset_parameters": { "adAccountId": "{{context:ocaAdAccountId}}" } }
```

`tool_context` on its own only produces headers under the deployment's context prefix (`X-Soat-Context-` by default), so a caller-named header can never overwrite the tool's own credential; the token lets the tool declare where the value goes.

- Valid in **`execute.headers`, `mcp.headers` and `preset_parameters` only** — never `execute.url`, `mcp.url`, `execute.auth`, or a model-supplied argument. Elsewhere it is rejected at write time with `400 INVALID_TEMPLATE_TOKEN`.
- In a preset the pin wins over anything the model supplies; the string value is retyped to the parameter's declared schema type. `{{secret:...}}` is **not** resolved in a preset; it stays literal.
- A key absent from the `tool_context` at call time **fails the tool call** with `400 MISSING_TOOL_CONTEXT_KEY`, naming the key and the header (or preset parameter). An empty-string value is a value, not a missing key.
- Both double-curly forms may appear in one header value and are substituted in a single pass.

Full rules: [Tool Context reference](./tool-context.md#placing-a-value-in-a-real-header).

## Dollar curly (formations and body params)

### `${Name}` in formation `sub`

Inside a formation template, `{"sub": "..."}` interpolates `${Name}` tokens at **apply time**. A token names a template parameter or a resource logical ID (resolved to its physical ID):

```json
{ "url": { "sub": "${AppUrl}/webhooks/${MyTrigger}" } }
```

### `${body.field}` in tool URLs

`${body.fieldName}` in `execute.url` is replaced at **call time** with the URL-encoded tool argument, exactly like `{param}`. It exists because `{param}` tokens cannot pass through a formation `sub` (the `sub` resolver owns `${...}` and skips `body.*` tokens on purpose):

```json
{ "url": { "sub": "${AppUrl}/expenses/${body.expense_id}" } }
```

Prefer `{param}` when defining tools directly via the API or CLI; use `${body.x}` when the URL is built by a formation `sub`.

## Formation object expressions

Formation resource properties support three single-key object forms, mirroring CloudFormation:

| Form | Meaning |
| ---- | ------- |
| `{"ref": "LogicalId"}` | The physical ID of another resource in the template |
| `{"param": "Name"}` | A template parameter value |
| `{"sub": "...${Name}..."}` | String interpolation of parameters and logical IDs |

See [Formations](../modules/formations.md).

## Composition — resolution phases in one string

Each family has its own delimiter and resolution phase, so they nest without escaping. A formation can produce a tool whose header carries a secret reference:

```json
{ "headers": { "Authorization": { "sub": "Bearer {{secret:${ApiSecret}}}" } } }
```

1. **Apply time** — `sub` resolves `${ApiSecret}` to the physical ID: the stored header becomes `Bearer {{secret:sec_01HXYZ}}`.
2. **Call time** — the secret token resolves to the decrypted value, only inside the outbound request.

The same phase rule covers `${body.x}`: `sub` leaves it alone at apply time so the tool resolver fills it at call time.

## Mostly not templating: request context

No `tool_context` value is interpolated into a URL, a body, or a JSON Logic expression. The server injects the generation's `tool_context` as `X-Soat-Context-*` **request headers** on every `http` and `mcp` tool call, alongside the tool's own `execute.headers` ([Tool Context reference](./tool-context.md)). The exceptions are declared by the tool itself: [`{{context:<key>}}`](#context-references-context) in its own `headers` and `preset_parameters`.

## Common mistakes

- **`{{param}}` in a tool URL** — double braces are secrets-only; use `{param}`. Rejected at write time with `400 INVALID_TEMPLATE_TOKEN`.
- **A `{{context:...}}` token outside `headers` or `preset_parameters`** — in a URL or an `execute.auth` block it is rejected with `400 INVALID_TEMPLATE_TOKEN`. Context always arrives as `X-Soat-Context-*` headers regardless. See [Tool Context](./tool-context.md).
- **camelCase `var` paths for run input** — run-input keys round-trip verbatim: an input sent as `cycle_task` is read as `{"var": "input.cycle_task"}`, not `cycleTask`.
- **Bare string as a state read** — in an `input_mapping`, a bare string is a literal. `"state.key"` does not read state; use `{"var": "key"}`.
- **Forward references** — a pipeline step may only read `steps.<id>` of an *earlier* step; formations reject circular `ref`/`sub` dependencies.
- **Expecting `{ var: ... }` to survive as data** — wrap logic-shaped literals in `preserve`.
