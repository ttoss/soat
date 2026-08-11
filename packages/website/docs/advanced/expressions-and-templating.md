---
description: "Complete reference for SOAT's six expression and templating pattern families and how each resolves at a different time so they compose without escaping."
---

# Expressions & Templating

Every place SOAT lets you map, transform, or interpolate values uses one of six pattern families. Each family has a distinct syntax because each resolves at a **different time** — that is what lets them compose in a single string without escaping rules. This page is the complete reference.

## Quick Reference

| Pattern | Syntax | Where it is valid | Resolves at |
| ------- | ------ | ----------------- | ----------- |
| [JSON Logic](#json-logic) | `{"var": "input.x"}`, `{"cat": [...]}`, `{"if": [...]}`, … | Orchestration `input_mapping`, `state_mapping`, `expression`, `exit_condition`; pipeline step `input` and pipeline `output`; tool `output_mapping` | Run / call time |
| [Dotted paths](#dotted-paths) | `state.a.b`, `text`, `MySecret.value` | Orchestration `state_mapping` keys, loop `collection`, and the `nodes.<id>` namespace; `output_path` on `tool_output` message content; formation `ref_attr` | Run / call / apply time |
| [`{param}`](#single-curly-param) | `/users/{user_id}` | `execute.url` of `http` tools | Call time |
| [Discussion tokens](#discussion-prompt-tokens) | `{topic}`, `{transcript}`, `{steps.<name>}`, `{steps.<name>.last}` | Discussion step prompts | Turn time |
| [`{{secret:...}}`](#secret-references-secret) | `{{secret:sec_01HXYZ}}` | `execute.url`, `execute.headers`, `mcp.url`, `mcp.headers` | Call time |
| [`{{context:...}}`](#context-references-context) | `{{context:ocaToken}}` | `execute.headers`, `mcp.headers` | Call time |
| [`${...}`](#dollar-curly-formations-and-body-params) | `${ParamName}`, `${LogicalId}`, `${body.field}` | Formation `sub` expressions; `execute.url` | Apply time (`${Name}`) / call time (`${body.x}`) |
| [Formation objects](#formation-object-expressions) | `{"ref": ...}`, `{"param": ...}`, `{"sub": ...}` | Formation template resource properties | Apply time |

## JSON Logic

[JSON Logic](https://jsonlogic.com) is the platform's single expression language for structured data mapping. One shared evaluator handles every surface, so operators behave identically everywhere.

An expression is a **single-key object whose key is a registered operator** — `var`, `cat`, `if`, comparison and arithmetic operators, `map`, and so on. Anything else is a literal: multi-key objects, arrays, and primitives are recursed into, so expressions can be nested at any depth inside literal structure.

```json
{
  "prompt": { "cat": ["Summarize: ", { "var": "input.text" }] },
  "isLong": { ">": [{ "var": "input.word_count" }, 500] },
  "data": { "title": { "var": "input.title" }, "static": "literal string" }
}
```

### Where each surface points `var`

The syntax is identical everywhere; only the **context root** differs:

| Surface | Field | `var` reads from |
| ------- | ----- | ---------------- |
| Orchestration node | `input_mapping` | Run state. Run input is seeded under the `input` namespace only — read it with `{"var": "input.key"}` (a flat `{"var": "key"}` is never satisfied by run input). Every upstream node's raw artifact is also available under `nodes.<nodeId>` (see [Dotted paths](#dotted-paths)). |
| Orchestration `transform` / `condition` | `expression` | Run state (same as above) |
| Orchestration `poll` | `exit_condition` | Run state plus `response` (latest tool result) and `attempt` |
| Orchestration node | `state_mapping` | `{ "output": <the node's own artifact>, "state": <run state> }` — note the different context root from every other orchestration surface |
| Pipeline tool step | `input` | `input.*` (tool call arguments) and `steps.<id>.*` (earlier step results) |
| Pipeline tool | `output` | Same as pipeline step `input` |
| Any tool (`http`, `mcp`, `pipeline`) | `output_mapping` | `output.*` (the tool's raw result) |

### Passing logic-shaped data as a literal

To pass an object that *looks like* an expression — for example, the literal payload `{"var": "x"}` — wrap it in `preserve`, which returns its argument unevaluated:

```json
{ "payload": { "preserve": { "var": "x" } } }
```

## Dotted paths

Plain dotted strings (no delimiters) appear where a value is an **address**, not an expression:

- **Orchestration `state_mapping` keys** — `{"state.summary": {"var": "output.content"}}` writes the node artifact's `content` field to `state.summary`, building nested objects along the way (`state.a.b` is readable back as `{"var": "a.b"}`). The `state.` prefix is optional. Keys are *state write paths*; values are JSON Logic (see [JSON Logic](#json-logic)) — the reverse-of-`input_mapping` shape (there, keys are input-parameter names and values point at the read source).
- **The `nodes.<id>` namespace** — every completed orchestration node's full artifact is recorded at `state.nodes.<nodeId>`, whether or not that node declares a `state_mapping`. A downstream node reads it with `{"var": "nodes.<nodeId>.<field>"}`, giving orchestrations the same read-any-upstream-result ergonomics as a pipeline's `steps.<id>` without explicit wiring. `nodes` is a reserved state key: a `state_mapping` write targeting it is rejected. (An `input_schema` property named `nodes` is fine — run input lives under `state.input`, so it cannot collide.)
- **Loop node `collection`** — `state.items.pending` names the state array to iterate.
- **`output_path` on `tool_output` message content** — extracts a field from a tool result before it enters a conversation (`"text"`, `"data.0.url"`; numeric segments index arrays).
- **Formation `ref_attr`** — `"MySecret.value"` reads an attribute of another resource: everything before the first dot is the logical ID, the rest is the attribute name.

:::note[Mapping keys are stored verbatim]

The keys of an `input_mapping`, `state_mapping`, or approval-node `arguments` are
names you author, and they leave SOAT exactly as written — an `input_mapping` key
becomes a sub-tool's request-body key, an `emit_event` node's `data` key, or a
line in the prompt an agent node builds. They are never case-converted, so a key
written `cost_center` arrives as `cost_center`, and any `{"var": ...}` that reads
it keeps the same spelling.

:::

Dotted paths also appear *inside* JSON Logic `var` strings (`{"var": "steps.call.text"}`, `{"var": "nodes.fetch.result"}`) — that is JSON Logic's addressing, not a separate mechanism.

## Single curly (`{param}`)

`execute.url` on `http` tools supports `{paramName}` placeholders, replaced at call time with the URL-encoded tool argument of the same name. Matched arguments are removed from the query/body; the rest pass through normally.

```json
{ "execute": { "url": "https://api.example.com/users/{user_id}/posts/{post_id}", "method": "DELETE" } }
```

This is the canonical URL placeholder syntax and intentionally matches OpenAPI path templating.

:::warning[Single braces, not double]
`{{city}}` is **not** a supported placeholder — double braces are reserved for [secret](#secret-references-secret) and [context](#context-references-context) references. Creating or updating a tool (directly, or via a formation) with any other `{{...}}` token in `execute`/`mcp` fields is rejected with `400 INVALID_TEMPLATE_TOKEN`. Always write `{city}`.
:::

## Discussion prompt tokens

A discussion always compiles to at most two engine steps: the fixed `deliberation` step (one branch per participant) and an optional `synthesis` step. Participant and synthesis prompts support a fixed allowlist of `{token}` substitutions, resolved before each turn:

| Token | Replaced with |
| ----- | ------------- |
| `{topic}` | The discussion run's topic |
| `{transcript}` | Prior turns within the current step (enables the shared sequential transcript) |
| `{steps.deliberation}` | Concatenated output of the deliberation step (only meaningful from `synthesis`) |
| `{steps.deliberation.last}` | Only the deliberation step's final turn |

Unknown tokens are left untouched (safe for literal braces in a prompt), but a `{token}` outside this allowlist — e.g. `{steps.synthesis}`, a self-reference, or a typo — is surfaced as a non-blocking entry in the discussion's `template_warnings` field, returned on every create, update, and read.

## Secret references (`{{secret:...}}`)

One of the two valid double-curly forms. A `{{secret:sec_...}}` token embeds a [Secret](../modules/secrets.md) by public ID inside `execute.url`, `execute.headers`, `mcp.url`, or `mcp.headers`:

```json
{ "execute": { "headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" } } }
```

The referenced secret must exist in the same project (validated at tool create/update; `400 SECRET_NOT_FOUND` otherwise). The stored tool — and every `GET`/`LIST` response — keeps the token; the decrypted value is substituted server-side only at the moment of the outbound request and is never echoed back.

## Context references (`{{context:...}}`)

The other valid double-curly form. A `{{context:<key>}}` token reads one key of the caller's [`tool_context`](./tool-context.md) for **this call** and substitutes it into a tool header:

```json
{ "mcp": { "headers": { "Authorization": "Bearer {{context:ocaToken}}" } } }
```

It exists because `tool_context` on its own can only produce `X-Soat-Context-<key>` headers — a security invariant, since a caller-named header could otherwise overwrite the tool's own credential. The token moves the header naming to the party that knows the header shape: the tool declares where the value goes, the caller supplies the value.

Unlike `{{secret:...}}`, it is valid in **`execute.headers` and `mcp.headers` only** — never `execute.url`, `mcp.url`, `execute.auth`, or a body. A context value is caller-supplied, and a URL it could steer is a request to a host the tool's author never configured. A token anywhere else is rejected at write time with `400 INVALID_TEMPLATE_TOKEN`.

A key that is not present in the `tool_context` at call time **fails the tool call** with `400 MISSING_TOOL_CONTEXT_KEY`, naming the key and the header. Sending `Authorization: Bearer ` instead would surface as an opaque upstream `401`, far from the real mistake. An empty-string value is a value, not a missing key.

Both forms may appear in one header value and are substituted in a single pass, so no substituted value is re-read as template source. Full rules, including which calling paths carry no context at all, are in the [Tool Context reference](./tool-context.md#placing-a-value-in-a-real-header).

## Dollar curly (formations and body params)

### `${Name}` in formation `sub`

Inside a formation template, `{"sub": "..."}` interpolates `${Name}` tokens at **apply time**. A token names either a template parameter or a resource logical ID (resolved to its physical ID):

```json
{ "url": { "sub": "${AppUrl}/webhooks/${MyTrigger}" } }
```

### `${body.field}` in tool URLs

`${body.fieldName}` in `execute.url` is replaced at **call time** with the URL-encoded tool argument, exactly like `{param}`. It exists because `{param}`-style tokens cannot pass through a formation `sub` (the `sub` resolver owns `${...}`, and skips `body.*` tokens on purpose):

```json
{ "url": { "sub": "${AppUrl}/expenses/${body.expense_id}" } }
```

Prefer `{param}` when defining tools directly via the API or CLI; use `${body.x}` when the URL is built by a formation `sub`.

## Formation object expressions

Formation resource properties support three single-key object forms, deliberately mirroring CloudFormation:

| Form | Meaning |
| ---- | ------- |
| `{"ref": "LogicalId"}` | The physical ID of another resource in the template |
| `{"param": "Name"}` | A template parameter value |
| `{"sub": "...${Name}..."}` | String interpolation of parameters and logical IDs |

See [Formations](../modules/formations.md) for the full model.

## Composition — resolution phases in one string

Because each family has its own delimiter and resolution phase, they nest without escaping. A formation can produce a tool whose header carries a secret reference:

```json
{ "headers": { "Authorization": { "sub": "Bearer {{secret:${ApiSecret}}}" } } }
```

1. **Apply time** — `sub` resolves `${ApiSecret}` to the physical ID: the stored header becomes `Bearer {{secret:sec_01HXYZ}}`.
2. **Call time** — the secret token resolves to the decrypted value, only inside the outbound request.

The same phase rule explains `${body.x}`: `sub` leaves it alone at apply time so the tool resolver can fill it at call time.

## Mostly not templating: request context

Session and actor context is **not** a general expression family: no `tool_context` value is ever interpolated into a URL, a body, or a JSON Logic expression. The server injects the generation's `tool_context` as `X-Soat-Context-*` **request headers** on every `http` and `mcp` tool call, alongside the tool's own `execute.headers`. That is the mechanism for getting the actor, session or caller identity into an outbound call — see the [Tool Context reference](./tool-context.md).

The single exception is [`{{context:<key>}}`](#context-references-context) in a tool's own `headers`, which reads one context value by name so a credential can land in the header the target actually expects.

## Common mistakes

- **`{{param}}` in a tool URL** — double braces are secrets-only; use `{param}`. Rejected at write time with `400 INVALID_TEMPLATE_TOKEN`.
- **A `{{context:...}}` token outside `headers`** — it is a headers-only affordance; in a URL or body it is rejected with `400 INVALID_TEMPLATE_TOKEN`. Context also always arrives as `X-Soat-Context-*` headers regardless. See [Tool Context](./tool-context.md).
- **camelCase `var` paths for run input** — orchestration run-input keys round-trip verbatim: an input sent as `cycle_task` is read as `{"var": "input.cycle_task"}`, not `cycleTask`.
- **Bare string as a state read** — in an `input_mapping`, a bare string is a literal. `"state.key"` does not read state; use `{"var": "key"}`.
- **Forward references** — a pipeline step may only read `steps.<id>` of an *earlier* step; formations reject circular `ref`/`sub` dependencies.
- **Expecting `{ var: ... }` to survive as data** — wrap logic-shaped literals in `preserve`.
