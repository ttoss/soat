# Expressions & Templating

Every place SOAT lets you map, transform, or interpolate values uses one of six pattern families. Each family has a distinct syntax because each resolves at a **different time** — that is what lets them compose in a single string without escaping rules. This page is the complete reference.

## Quick Reference

| Pattern | Syntax | Where it is valid | Resolves at |
| ------- | ------ | ----------------- | ----------- |
| [JSON Logic](#json-logic) | `{"var": "input.x"}`, `{"cat": [...]}`, `{"if": [...]}`, … | Orchestration `input_mapping`, `expression`, `exit_condition`; pipeline step `input` and pipeline `output`; tool `output_mapping` | Run / call time |
| [Dotted paths](#dotted-paths) | `state.a.b`, `text`, `MySecret.value` | Orchestration `output_mapping` values and loop `collection`; `output_path` on `tool_output` message content; formation `ref_attr` | Run / call / apply time |
| [`{param}`](#single-curly-param) | `/users/{user_id}` | `execute.url` of `http` tools | Call time |
| [Discussion tokens](#discussion-prompt-tokens) | `{topic}`, `{transcript}`, `{steps.<name>}`, `{steps.<name>.last}` | Discussion step prompts | Turn time |
| [`{{secret:...}}`](#secret-references-secret) | `{{secret:sec_01HXYZ}}` | `execute.url`, `execute.headers`, `mcp.url`, `mcp.headers` | Call time |
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
| Orchestration node | `input_mapping` | Run state. Run input is available both flat (`{"var": "key"}`) and namespaced (`{"var": "input.key"}`) — prefer `input.key`. |
| Orchestration `transform` / `condition` | `expression` | Run state (same as above) |
| Orchestration `poll` | `exit_condition` | Run state plus `response` (latest tool result) and `attempt` |
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

- **Orchestration `output_mapping` values** — `{"content": "state.summary"}` writes the node artifact's `content` field to `state.summary`, building nested objects along the way (`state.a.b` is readable back as `{"var": "a.b"}`). The `state.` prefix is optional. Note the direction: keys are *artifact fields*, values are *state write paths* — the reverse of `input_mapping`.
- **Loop node `collection`** — `state.items.pending` names the state array to iterate.
- **`output_path` on `tool_output` message content** — extracts a field from a tool result before it enters a conversation (`"text"`, `"data.0.url"`; numeric segments index arrays).
- **Formation `ref_attr`** — `"MySecret.value"` reads an attribute of another resource: everything before the first dot is the logical ID, the rest is the attribute name.

Dotted paths also appear *inside* JSON Logic `var` strings (`{"var": "steps.call.text"}`) — that is JSON Logic's addressing, not a separate mechanism.

## Single curly (`{param}`)

`execute.url` on `http` tools supports `{paramName}` placeholders, replaced at call time with the URL-encoded tool argument of the same name. Matched arguments are removed from the query/body; the rest pass through normally.

```json
{ "execute": { "url": "https://api.example.com/users/{user_id}/posts/{post_id}", "method": "DELETE" } }
```

This is the canonical URL placeholder syntax and intentionally matches OpenAPI path templating.

:::warning Single braces, not double
`{{city}}` is **not** a supported placeholder — double braces are reserved for [secret references](#secret-references-secret). The resolver matches the inner `{city}` and leaves the outer braces in the URL, producing `?city={London}`. Always write `{city}`.
:::

## Discussion prompt tokens

Discussion step prompts support a fixed allowlist of `{token}` substitutions, resolved before each turn:

| Token | Replaced with |
| ----- | ------------- |
| `{topic}` | The discussion run's topic |
| `{transcript}` | Prior turns within the current step (enables the shared sequential transcript) |
| `{steps.<name>}` | Concatenated output of an earlier step |
| `{steps.<name>.last}` | Only the final turn of an earlier step |

Unknown tokens are left untouched, so literal braces in a prompt are safe.

## Secret references (`{{secret:...}}`)

The **only** valid double-curly syntax. A `{{secret:sec_...}}` token embeds a [Secret](../modules/secrets.md) by public ID inside `execute.url`, `execute.headers`, `mcp.url`, or `mcp.headers`:

```json
{ "execute": { "headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" } } }
```

The referenced secret must exist in the same project (validated at tool create/update; `400 SECRET_NOT_FOUND` otherwise). The stored tool — and every `GET`/`LIST` response — keeps the token; the decrypted value is substituted server-side only at the moment of the outbound request and is never echoed back.

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

## Common mistakes

- **`{{param}}` in a tool URL** — double braces are secrets-only; use `{param}`.
- **camelCase `var` paths for run input** — orchestration run-input keys round-trip verbatim: an input sent as `cycle_task` is read as `{"var": "input.cycle_task"}`, not `cycleTask`.
- **Bare string as a state read** — in an `input_mapping`, a bare string is a literal. `"state.key"` does not read state; use `{"var": "key"}`.
- **Forward references** — a pipeline step may only read `steps.<id>` of an *earlier* step; formations reject circular `ref`/`sub` dependencies.
- **Expecting `{ var: ... }` to survive as data** — wrap logic-shaped literals in `preserve`.
