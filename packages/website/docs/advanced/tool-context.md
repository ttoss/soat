---
description: 'How session and actor context reaches a tool endpoint as X-Soat-Context-* request headers: the exact key-to-header rule, the auto-populated keys, precedence, and validation.'
---

# Tool Context

`tool_context` is a flat `Record<string, string>` a caller attaches to a generation. Every entry is forwarded as an HTTP **request header** on each tool call the generation makes, so a server-side tool can authorize against the caller's identity instead of trusting data embedded in the prompt.

This page is the canonical contract. `tool_context` is **not** general templating: a value is never interpolated into a URL or a request body. The one place a value is read by name is a tool's own `headers`, via a `{{context:<key>}}` token the **tool** declares — see [Placing a value in a real header](#placing-a-value-in-a-real-header) below and [Expressions & Templating](./expressions-and-templating.md).

## Where it is accepted

| Surface | Field |
| --- | --- |
| `POST /api/v1/agents/{agent_id}/generate` | `tool_context` in the body |
| `POST /api/v1/sessions` / `PATCH /api/v1/sessions/{session_id}` | `tool_context` — persisted on the session, applied to every generation in it |
| `POST /api/v1/sessions/{session_id}/messages` and `.../generate` | `tool_context` — per-request, this generation only |
| `POST /api/v1/conversations/{conversation_id}/generate` | `tool_context` in the body |
| `POST /api/v1/orchestration-runs` | `tool_context` — persisted on the run, applied to the generation of every `agent` node it executes, and inherited by `loop`/`sub_orchestration` child runs (see [Run Tool Context](../modules/orchestrations.md#run-tool-context)) |
| `POST /api/v1/tasks` | `tool_context` — persisted on the task, applied to the dispatches of the entry state's `on_enter` |
| `POST /api/v1/tasks/{task_id}/transitions` | `tool_context` — **replaces** the task's stored bag; omitting it keeps it (see [Dispatch tool context](../modules/workflows.md#dispatch-tool-context)) |
| Formation templates | `tool_context` on a `Session` resource |

## Which tools receive the headers

| Tool type | Headers forwarded | Notes |
| --- | --- | --- |
| `http` | Yes | Injected as request headers on the outbound call |
| `mcp` | Yes | Injected on the MCP `tools/call` fetch |
| `soat` | Yes | Propagated into nested agent generations |
| `client` | **No** | Executes on the caller's side; nothing is sent |

Context headers are applied **after** any headers configured on the tool's `execute.headers` / `mcp.headers`, so a context header wins over a tool-defined header with the same name.

By default a tool receives **every** key in the bag. A tool can narrow that to an allowlist with [`context_keys`](../modules/tools.md#scoping-which-context-keys-reach-a-tool) — the containment half of carrying a credential in `tool_context`, and the answer to "mind what egresses" below:

```json
{ "name": "list-orders", "type": "http", "context_keys": ["tenant"] }
```

The [auto-populated identity keys](#auto-populated-keys-sessions) are always forwarded regardless of the allowlist, and a key consumed by a `{{context:<key>}}` token in the tool's own headers is substituted regardless of it too.

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
| Where the token is allowed | `execute.headers` and `mcp.headers` only. Anywhere else — `execute.url`, `mcp.url`, `execute.auth`, a body — is rejected at write time with `400 INVALID_TEMPLATE_TOKEN`. A context value is caller-supplied, so it must not be able to steer the outbound URL. |
| Key grammar | Identical to a `tool_context` key's — one grammar, so the two cannot disagree about which keys exist. An invalid key is rejected at write time, not at first call. |
| Missing key at call time | The tool call **fails** with `400 MISSING_TOOL_CONTEXT_KEY`, naming the key and header. An `Authorization: Bearer ` with no value would reach the endpoint and come back as an opaque upstream `401`, several steps from the actual mistake. |
| Empty-string value | A value, not a missing key — the header is sent empty, because that is what the caller asked for. |
| With `{{secret:...}}` | Both kinds may appear in the same header value and are substituted in a **single pass**, so a substituted value is never re-scanned as template source: a `tool_context` value containing `{{secret:sec_...}}` stays literal text, and so does a secret whose plaintext contains `{{context:...}}`. |
| Calling paths with no context | `POST /api/v1/tools/{tool_id}/call` and an orchestration `tool` node carry no `tool_context`, so a tool declaring `{{context:...}}` cannot be invoked through them — the call fails with `MISSING_TOOL_CONTEXT_KEY`. Bind such a tool to an agent and call it through a generation, session or orchestration `agent` node. |

The token is resolved at the point of use. `GET /tools` echoes back the token, never the resolved value — the same as `{{secret:...}}`.

## Key → header name

The header name is the context prefix — `X-Soat-Context-` unless your deployment [configures another one](#configuring-the-header-prefix) — followed by your key, **verbatim**. No character is re-cased and no separator is collapsed:

| `tool_context` key | Forwarded header |
| --- | --- |
| `userId` | `X-Soat-Context-userId` |
| `tenantId` | `X-Soat-Context-tenantId` |
| `actorExternalId` | `X-Soat-Context-actorExternalId` |
| `actor_external_id` | `X-Soat-Context-actor_external_id` |
| `actor-external-id` | `X-Soat-Context-actor-external-id` |
| `actor.external.id` | `X-Soat-Context-actor.external.id` |
| `TenantId` | `X-Soat-Context-TenantId` |
| `env` | `X-Soat-Context-env` |

The table is a formality — the rule is string concatenation. `actor_external_id` and `actorExternalId` are two different keys and produce two different headers.

**Keys are never case-converted.** Unlike every other field in the REST API, `tool_context` keys are not rewritten between snake_case and camelCase: a key is an HTTP header name, not a SOAT field name, so it is stored, echoed in responses, and forwarded exactly as you wrote it — on REST, in formation templates, and over MCP alike. Reading a session's `tool_context` and sending it back unchanged is lossless.

### Read the header case-insensitively

HTTP field names are case-insensitive ([RFC 9110 §5.1](https://www.rfc-editor.org/rfc/rfc9110#section-5.1)), and HTTP/2 and HTTP/3 transmit them lowercased ([RFC 9113 §8.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.1)). Your endpoint will usually see `x-soat-context-userid` no matter how you spelled the key, so the casing in the table above is presentational.

Look the header up through your framework's normal accessor, which already handles this:

```js
// Node / Express / Koa — incoming header names are lowercased for you
const userId = req.headers['x-soat-context-userid'];
```

Do not match `X-Soat-Context-userId` as an exact string, and make any gateway, WAF, or log-routing rule that references these headers case-insensitive.

:::note[Changed in recent releases]

Two changes to this rule landed in quick succession. If you are upgrading from before either, check both.

1. **Keys are no longer case-converted.** A key used to be rewritten like any other body field, so `actor_external_id` sent over REST was stored as `actorExternalId` and produced `X-Soat-Context-ActorExternalId`. Keys are now stored, echoed, and forwarded exactly as sent. If a tool endpoint of yours reads a camelCase context header fed by an explicitly-set snake_case key, either rename the key to camelCase or read the snake_case header.
2. **The first character is no longer uppercased.** `userId` produced `X-Soat-Context-UserId` and now produces `X-Soat-Context-userId`. This is invisible to any client that looks headers up the normal way, for the reasons above. It matters only if something on your side matches the header name as an exact string.

Session-auto-populated keys (`sessionId` / `actorId` / `actorExternalId`) were and remain camelCase; only the emitted header's first character changed.

:::

## Auto-populated keys (sessions)

When a generation runs through a [session](../modules/sessions.md), the server injects these keys automatically:

| Injected key | Forwarded header | Value |
| --- | --- | --- |
| `sessionId` | `X-Soat-Context-sessionId` | Public ID of the session; always present |
| `actorId` | `X-Soat-Context-actorId` | Public ID of the session's actor; omitted if not set |
| `actorExternalId` | `X-Soat-Context-actorExternalId` | `external_id` of the session's actor; omitted if not set |

You do not need to set these yourself — a session-backed generation already carries them.

### Precedence

For every other key, later wins — a per-request `tool_context` overrides the session's stored `tool_context`:

```
session tool_context  <  per-request tool_context
```

The three auto-populated keys (`sessionId`, `actorId`, `actorExternalId`) are the exception: they are always taken from the session and its actor, and a caller-supplied value for one of them — in either the stored or the per-request `tool_context` — is ignored. A tool endpoint can rely on these three headers reflecting the real session/actor even if the caller tries to set them.

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
| `actor_external_id` | `X-Acme-Context-actor_external_id` |

Everything else is unchanged: the prefix is prepended verbatim (include the trailing `-` yourself), the key is still never re-cased, the [auto-populated keys](#auto-populated-keys-sessions) still take the same names after the prefix, and the [validation rules](#validation) above are evaluated against the configured prefix.

Two constraints:

- **The value must be a valid HTTP header-name prefix** — letters, digits and ``!#$%&'*+-.^_`|~``. An invalid prefix fails the tool call with an error naming the variable, rather than surfacing as an opaque `fetch` failure mid-generation.
- **The prefix cannot be removed.** An empty or unset value keeps the default. Without a prefix, a caller-supplied `tool_context` key could name any header at all — `Authorization` included — and override a credential the tool definition configured.

Changing the prefix on a running deployment breaks every tool endpoint already reading the old header names, third-party endpoints included. Set it before wiring up tools, or migrate both sides together.

## Security

The forwarded headers are the point: a tool endpoint can trust them in a way it cannot trust the prompt. Two things to keep in mind.

**Verify the caller.** Any client that can reach your tool endpoint can set an `X-Soat-Context-*` header by hand. The headers are trustworthy only if the endpoint also authenticates the request as coming from SOAT (a shared secret in `execute.headers`, mTLS, or network-level restriction). Treat them as *attested by SOAT*, not as *unforgeable*.

**Mind what egresses.** Unless a tool sets [`context_keys`](../modules/tools.md#scoping-which-context-keys-reach-a-tool), every value is transmitted to every `http`, `mcp` and `soat` tool the agent calls, including endpoints you do not control. Set `context_keys` on the tools that need a given key — particularly when a key holds a credential. This applies to the auto-populated `actorExternalId`: if an [Actor](../modules/actors.md)'s `external_id` holds a phone number or an email address, that PII reaches every third-party tool endpoint in the agent's tool set. When the tool set includes third-party endpoints, prefer an opaque internal identifier as `external_id` and correlate to the real contact detail on your own side.

## Example

```bash
soat create-session \
  --agent-id agent_01 \
  --actor-id actor_01 \
  --tool-context '{"tenantId":"acme","plan":"pro"}'
```

Every `http` tool call in that session then receives:

```http
X-Soat-Context-sessionId: sess_01
X-Soat-Context-actorId: actor_01
X-Soat-Context-actorExternalId: +5511999999999
X-Soat-Context-tenantId: acme
X-Soat-Context-plan: pro
```
