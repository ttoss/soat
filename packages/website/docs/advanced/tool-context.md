---
description: 'How session and actor context reaches a tool endpoint as X-Soat-Context-* request headers: the exact key-to-header rule, the auto-populated keys, precedence, and validation.'
---

# Tool Context

`tool_context` is a flat `Record<string, string>` a caller attaches to a generation. Every entry is forwarded as an HTTP **request header** on each tool call the generation makes, so a server-side tool can authorize against the caller's identity instead of trusting data embedded in the prompt.

This page is the canonical contract. `tool_context` is **not** general templating: a value is never interpolated into a URL, and never into arguments the model chooses. The two places a value is read by name are both declared by the **tool** — its own `headers`, and its `preset_parameters` — via a `{{context:<key>}}` token. See [Placing a value in a real header](#placing-a-value-in-a-real-header) and [Pinning a parameter to the run's value](#pinning-a-parameter-to-the-runs-value) below, and [Expressions & Templating](./expressions-and-templating.md).

## Where it is accepted

| Surface | Field |
| --- | --- |
| [`POST /api/v1/agents/{agent_id}/generate`](/docs/api/agents/create-agent-generation) | `tool_context` in the body |
| [`POST /api/v1/sessions`](/docs/api/sessions/create-session) / [`PATCH /api/v1/sessions/{session_id}`](/docs/api/sessions/update-session) | `tool_context` — persisted on the session, applied to every generation in it |
| [`POST /api/v1/sessions/{session_id}/messages`](/docs/api/sessions/add-session-message) and `.../generate` | `tool_context` — per-request, this generation only |
| [`POST /api/v1/conversations/{conversation_id}/generate`](/docs/api/conversations/generate-conversation-message) | `tool_context` in the body |
| [`POST /api/v1/orchestration-runs`](/docs/api/orchestrations/start-orchestration-run) | `tool_context` — persisted on the run, applied to the generation of every `agent` node it executes, to the tool call of every `tool` and `poll` node, and inherited by `loop`/`sub_orchestration` child runs — narrowable per node with [`context_keys`](../modules/orchestrations.md#narrowing-what-a-child-run-inherits) (see [Run Tool Context](../modules/orchestrations.md#run-tool-context)) |
| [`POST /api/v1/tasks`](/docs/api/tasks/create-task) | `tool_context` — persisted on the task, applied to the dispatches of the entry state's `on_enter` (all three kinds: `agent`, `tool`, `orchestration`) |
| [`POST /api/v1/tasks/{task_id}/transitions`](/docs/api/tasks/transition-task) | `tool_context` — **replaces** the task's stored bag; omitting it keeps it (see [Dispatch tool context](../modules/workflows.md#dispatch-tool-context)) |
| [`POST /api/v1/evals/{eval_id}/runs`](/docs/api/evaluations/start-eval-run) | `tool_context` — persisted on the run and applied to every item's generation, so an agent is scored as it runs in production. Write-only, and cleared when the run settles (see [Run tool context](../modules/evaluations.md#run-tool-context)) |
| [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool) | `tool_context` — this call only ([below](#calling-a-context-dependent-tool-directly)) |
| Formation templates | `tool_context` on a `Session` resource |

## Which tools receive the headers

| Tool type | Headers forwarded | Notes |
| --- | --- | --- |
| `http` | Yes | Injected as request headers on the outbound call |
| `mcp` | Yes | Injected on the MCP `tools/call` fetch |
| `builtin` | Yes | Propagated into nested agent generations |
| `client` | **No** | Executes on the caller's side; nothing is sent. A `{{context:}}` preset is still resolved before the arguments are handed over |
| `pipeline` | Yes | Each step inherits the context the pipeline was called with |

Context headers are applied **after** any headers configured on the tool's `execute.headers` / `mcp.headers`, so a context header wins over a tool-defined header with the same name.

A generation's bag also reaches the tool calls it makes **before the model runs**: a `tool_output` message content block asks the server to call a tool and inline its result into the prompt, and that call carries the same identity-pinned bag the model's own tool calls do.

By default a tool receives **every** key in the bag. A tool can narrow that to an allowlist with [`context_keys`](../modules/tools.md#scoping-which-context-keys-reach-a-tool) — the containment half of carrying a credential in `tool_context`, and the answer to "mind what egresses" below:

```json
{ "name": "list-orders", "type": "http", "context_keys": ["tenant"] }
```

The [auto-populated identity keys](#auto-populated-keys-sessions) are always forwarded regardless of the allowlist, and a key consumed by a `{{context:<key>}}` token in the tool's own headers or `preset_parameters` is substituted regardless of it too — the allowlist governs what is *handed* to a tool that never asked for it, while a token is the tool naming the key it consumes.

When a generation pauses with `status: "requires_action"`, the `tool_context` from the original request is preserved and reapplied on resume. An orchestration run gets the same guarantee from its own row rather than from the paused generation: it survives an `awaiting_input` pause, a `sleeping` wait, a background worker drive and a crash redrive, none of which carry a request a bag could travel in. A [task](../modules/workflows.md#dispatch-tool-context) stores its bag the same way, which is what carries it across an approval gate, a retry and an automated hop — its pauses are measured in days, not seconds.

Where a session's and a run's bag is readable, a **task's is write-only**: a task is long-lived and read by every principal on the board, so its stored bag is never returned by a read and is cleared when the task closes.

## Placing a value in a real header

`tool_context` by itself can only ever produce headers under the deployment's [context prefix](#configuring-the-header-prefix) (`X-Soat-Context-` by default). That a prefix is always applied, and that the caller cannot choose it, is a security invariant rather than an inconvenience: if a caller-supplied key could name any header, it could overwrite the tool's own configured credential or the server-pinned identity headers, and context headers are spread **last** in the header build.

When a target needs the value in a header of its own — almost always `Authorization` — the **tool definition** says so, with a `{{context:<key>}}` token in its `headers`:

```yaml
mcp:
  headers:
    Authorization: 'Bearer {{context:ocaToken}}'
```

```yaml
execute:
  url: https://api.example.com/v1/orders
  headers:
    Authorization: 'Bearer {{context:ocaToken}}'
    X-Tenant: '{{context:tenant}}'
```

The authority is split on purpose: the tool knows the header shape its endpoint expects, and the caller only supplies the value. Nothing about `tool_context` itself changes — the same call still also sends the prefixed `…-ocaToken` context header, so a target may read either.

| Rule | Behavior |
| --- | --- |
| Where the token is allowed | `execute.headers`, `mcp.headers` and [`preset_parameters`](#pinning-a-parameter-to-the-runs-value). Anywhere else — `execute.url`, `mcp.url`, `execute.auth`, a body — is rejected at write time with `400 INVALID_TEMPLATE_TOKEN`. A context value is caller-supplied, so it must not be able to steer the outbound URL. |
| Key grammar | Identical to a `tool_context` key's — one grammar, so the two cannot disagree about which keys exist. An invalid key is rejected at write time, not at first call. |
| Missing key at call time | The tool call **fails** with `400 MISSING_TOOL_CONTEXT_KEY`, naming the key and header. An `Authorization: Bearer ` with no value would reach the endpoint and come back as an opaque upstream `401`, several steps from the actual mistake. |
| Empty-string value | A value, not a missing key — the header is sent empty, because that is what the caller asked for. |
| With `{{secret:...}}` | Both kinds may appear in the same header value and are substituted in a **single pass**, so a substituted value is never re-scanned as template source: a `tool_context` value containing `{{secret:sec_...}}` stays literal text, and so does a secret whose plaintext contains `{{context:...}}`. |
| Calling paths | Every dispatch surface carries a bag. [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool) takes one in its body ([below](#calling-a-context-dependent-tool-directly)); orchestration `tool` and `poll` nodes carry the run's, and so does every step of a `pipeline` tool. A tool declaring `{{context:...}}` that is called without the key it needs fails with `MISSING_TOOL_CONTEXT_KEY`. |

The token is resolved at the point of use. [`GET /tools`](/docs/api/tools/list-tools) echoes back the token, never the resolved value — the same as `{{secret:...}}`.

## Pinning a parameter to the run's value

A header carries the credential; it cannot carry the **scope** the credential must be confined to. A token that reaches dozens of ad accounts is still one token, and which account this run may act on is a decision the caller makes per run — not one the model should make, and not one that can be frozen into the tool when it is created.

`preset_parameters` accepts the same `{{context:<key>}}` token, which closes that gap:

```json
{
  "type": "mcp",
  "mcp": { "headers": { "Authorization": "Bearer {{context:ocaToken}}" } },
  "context_keys": ["ocaToken", "ocaAdAccountId"],
  "preset_parameters": { "adAccountId": "{{context:ocaAdAccountId}}" }
}
```

A preset is a **pin**: it wins over whatever the model (or a direct caller) supplies for the same key, and the key is hidden from the schema the model sees. Resolving the token from `tool_context` therefore makes the pin a genuine per-run boundary — one tool serving many tenants, instead of one tool per tenant.

| Rule | Behavior |
| --- | --- |
| Where it resolves from | This call's `tool_context`, the same bag the headers read. The [allowlist](#which-tools-receive-the-headers) does not gate it. |
| Missing key at call time | The tool call **fails** with `400 MISSING_TOOL_CONTEXT_KEY`, naming the parameter and the key. The literal `{{context:...}}` text reaching the target as a resource id comes back as an opaque `not found`, several steps from the mistake. |
| Type | Context values are strings; a resolved value is retyped to what the target's schema declares for that parameter (`integer`, `number`, `boolean`), so the same account can be `adAccountId: "act_…"` on one action and `metaAdAccountId: 123` on another. A value the declared type cannot accept is left as the string it is, for the target to reject. |
| Nesting | Tokens are resolved at any depth — inside a nested object or an array element, not only at the top level. |
| `{{secret:...}}` | **Not** resolved in a preset, and not an error: the token stays literal. A preset value travels into the request body, into guardrail evaluation and into the activity record, so secrets stay in headers. |
| Guardrails | A guard sees the resolved value in `args.*`, and an approval item records it — the arguments the call will actually carry. |

## Calling a context-dependent tool directly

[`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool) takes a `tool_context` of its own, so a tool that authorizes through the bag can be exercised without an agent in between — which is how you smoke-test one:

```bash
soat call-tool \
  --tool-id tool_01 \
  --input '{"order_id":"ord_42"}' \
  --tool-context '{"ocaToken":"tok_abc123","tenant":"acme"}'
```

The bag behaves as it does anywhere else: it resolves `{{context:...}}` in `execute.headers`, `mcp.headers` and `preset_parameters`, it is forwarded as `X-Soat-Context-*` headers, and the tool's [`context_keys`](../modules/tools.md#scoping-which-context-keys-reach-a-tool) narrows it.

One difference, and it is the reason this route was the last one to get a bag. There is no session here, so there is no server-derived identity to stamp — and therefore nothing that would overwrite a caller-supplied `session_id`. The [auto-populated keys](#auto-populated-keys-sessions) are dropped from this bag rather than forwarded, in any casing, so a tool endpoint can still read `X-Soat-Context-session_id` as a value SOAT derived rather than one a caller chose.

## Key → header name

The header name is the context prefix — `X-Soat-Context-` unless your deployment [configures another one](#configuring-the-header-prefix) — followed by your key, **verbatim**. No character is re-cased and no separator is collapsed:

| `tool_context` key | Forwarded header |
| --- | --- |
| `userId` | `X-Soat-Context-userId` |
| `tenantId` | `X-Soat-Context-tenantId` |
| `tenantExternalId` | `X-Soat-Context-tenantExternalId` |
| `tenant_external_id` | `X-Soat-Context-tenant_external_id` |
| `tenant-external-id` | `X-Soat-Context-tenant-external-id` |
| `tenant.external.id` | `X-Soat-Context-tenant.external.id` |
| `TenantId` | `X-Soat-Context-TenantId` |
| `env` | `X-Soat-Context-env` |

The table is a formality — the rule is string concatenation. `tenant_external_id` and `tenantExternalId` are two different keys and produce two different headers.

**Keys are never case-converted.** Unlike every other field in the REST API, `tool_context` keys are not rewritten between snake_case and camelCase: a key is an HTTP header name, not a SOAT field name, so it is stored, echoed in responses, and forwarded exactly as you wrote it — on REST, in formation templates, and over MCP alike. Reading a session's `tool_context` and sending it back unchanged is lossless.

### Read the header case-insensitively

HTTP field names are case-insensitive ([RFC 9110 §5.1](https://www.rfc-editor.org/rfc/rfc9110#section-5.1)), and HTTP/2 and HTTP/3 transmit them lowercased ([RFC 9113 §8.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.1)). Your endpoint will usually see `x-soat-context-userid` no matter how you spelled the key, so the casing in the table above is presentational.

Look the header up through your framework's normal accessor, which already handles this:

```js
// Node / Express / Koa — incoming header names are lowercased for you
const userId = req.headers['x-soat-context-userid'];
```

Do not match `X-Soat-Context-userId` as an exact string, and make any gateway, WAF, or log-routing rule that references these headers case-insensitive.

## Auto-populated keys (sessions)

When a generation runs through a [session](../modules/sessions.md), the server injects these keys automatically:

| Injected key | Forwarded header | Value |
| --- | --- | --- |
| `session_id` | `X-Soat-Context-session_id` | Public ID of the session; always present |
| `actor_id` | `X-Soat-Context-actor_id` | Public ID of the session's actor; omitted if not set |
| `actor_external_id` | `X-Soat-Context-actor_external_id` | `external_id` of the session's actor; omitted if not set |

You do not need to set these yourself — a session-backed generation already carries them.

### Precedence

For every other key, later wins — a per-request `tool_context` overrides the session's stored `tool_context`:

```
session tool_context  <  per-request tool_context
```

The three auto-populated keys (`session_id`, `actor_id`, `actor_external_id`) are the exception: they are always taken from the session and its actor, and a caller-supplied value for one of them — in either the stored or the per-request `tool_context` — is ignored. A tool endpoint can rely on these three headers reflecting the real session/actor even if the caller tries to set them.

## Validation

A key becomes an HTTP header name, so it must be a valid one. A request whose `tool_context` violates either rule below is rejected with **`400 INVALID_TOOL_CONTEXT_KEY`** at write time (`create-session`, `update-session`) or before the provider call (generation endpoints):

1. **Character set** — a key may contain only letters, digits and ``!#$%&'*+-.^_`|~``. A key with a space, colon, parenthesis, newline or non-ASCII character is rejected. (`meta.keys` lists the offending keys.)
2. **No collisions** — two keys must not map to the same header field. Because header names are case-insensitive, `userId` and `UserId` produce two different header strings that HTTP folds into one, and one value would be silently dropped. (`meta.header` names the colliding header; `meta.keys` lists both keys.)

A tool's `context_keys` entries are held to rule 1 as well, and rejected with the same code at `create-tool` / `update-tool`: an entry names a key, so an entry no key could ever match is a typo, not an allowlist.

There is no length or total-header-bytes limit enforced by SOAT; the receiving server's own header limits apply.

## Configuring the header prefix

The prefix is deployment configuration, not part of the request. A self-hosted deployment sets `TOOL_CONTEXT_HEADER_PREFIX` to replace `X-Soat-Context-` on every context header it emits — the case for it is white-labeling: a platform fronting SOAT under its own name should not send that name to the third-party tool endpoints its agents call.

```bash
TOOL_CONTEXT_HEADER_PREFIX=X-Acme-Context-
```

| `tool_context` key | Forwarded header |
| --- | --- |
| `userId` | `X-Acme-Context-userId` |
| `tenant_external_id` | `X-Acme-Context-tenant_external_id` |

Everything else is unchanged: the prefix is prepended verbatim (include the trailing `-` yourself), the key is still never re-cased, the [auto-populated keys](#auto-populated-keys-sessions) still take the same names after the prefix, and the [validation rules](#validation) above are evaluated against the configured prefix.

Two constraints:

- **The value must be a valid HTTP header-name prefix** — letters, digits and ``!#$%&'*+-.^_`|~``. An invalid prefix fails the tool call with an error naming the variable, rather than surfacing as an opaque `fetch` failure mid-generation.
- **The prefix cannot be removed.** An empty or unset value keeps the default. Without a prefix, a caller-supplied `tool_context` key could name any header at all — `Authorization` included — and override a credential the tool definition configured.

Changing the prefix on a running deployment breaks every tool endpoint already reading the old header names, third-party endpoints included. Set it before wiring up tools, or migrate both sides together.

## Security

The forwarded headers are the point: a tool endpoint can trust them in a way it cannot trust the prompt. Two things to keep in mind.

**Verify the caller.** Any client that can reach your tool endpoint can set an `X-Soat-Context-*` header by hand. The headers are trustworthy only if the endpoint also authenticates the request as coming from SOAT (a shared secret in `execute.headers`, mTLS, or network-level restriction). Treat them as *attested by SOAT*, not as *unforgeable*.

**Mind what egresses.** Unless a tool sets [`context_keys`](../modules/tools.md#scoping-which-context-keys-reach-a-tool), every value is transmitted to every `http`, `mcp` and `builtin` tool the agent calls, including endpoints you do not control. Set `context_keys` on the tools that need a given key — particularly when a key holds a credential. This applies to the auto-populated `actor_external_id`: if an [Actor](../modules/actors.md)'s `external_id` holds a phone number or an email address, that PII reaches every third-party tool endpoint in the agent's tool set. When the tool set includes third-party endpoints, prefer an opaque internal identifier as `external_id` and correlate to the real contact detail on your own side.

## Example

```bash
soat create-session \
  --agent-id agent_01 \
  --actor-id actor_01 \
  --tool-context '{"tenantId":"acme","plan":"pro"}'
```

Every `http` tool call in that session then receives:

```http
X-Soat-Context-session_id: sess_01
X-Soat-Context-actor_id: actor_01
X-Soat-Context-actor_external_id: +5511999999999
X-Soat-Context-tenantId: acme
X-Soat-Context-plan: pro
```
