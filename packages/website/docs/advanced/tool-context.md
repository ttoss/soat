---
description: 'How session and actor context reaches a tool endpoint as X-Soat-Context-* request headers: the exact key-to-header rule, the auto-populated keys, precedence, and validation.'
---

# Tool Context

`tool_context` is a flat `Record<string, string>` a caller attaches to a generation. Every entry is forwarded as an HTTP **request header** on each tool call the generation makes, so a server-side tool can authorize against the caller's identity instead of trusting data embedded in the prompt.

This page is the canonical contract. `tool_context` is **not** templating — the values are never interpolated into a URL or body, and there is no `{{context:...}}` token (see [Expressions & Templating](./expressions-and-templating.md)).

## Where it is accepted

| Surface | Field |
| --- | --- |
| `POST /api/v1/agents/{agent_id}/generate` | `tool_context` in the body |
| `POST /api/v1/sessions` / `PATCH /api/v1/sessions/{session_id}` | `tool_context` — persisted on the session, applied to every generation in it |
| `POST /api/v1/sessions/{session_id}/messages` and `.../generate` | `tool_context` — per-request, this generation only |
| `POST /api/v1/conversations/{conversation_id}/generate` | `tool_context` in the body |
| Formation templates | `tool_context` on a `Session` resource |

## Which tools receive the headers

| Tool type | Headers forwarded | Notes |
| --- | --- | --- |
| `http` | Yes | Injected as request headers on the outbound call |
| `mcp` | Yes | Injected on the MCP `tools/call` fetch |
| `soat` | Yes | Propagated into nested agent generations |
| `client` | **No** | Executes on the caller's side; nothing is sent |

Context headers are applied **after** any headers configured on the tool's `execute.headers` / `mcp.headers`, so a context header wins over a tool-defined header with the same name.

When a generation pauses with `status: "requires_action"`, the `tool_context` from the original request is preserved and reapplied on resume.

## Key → header name

The header name is your key with its **first character uppercased** and `X-Soat-Context-` prepended. The rest of the key is used **verbatim**:

| `tool_context` key | Forwarded header |
| --- | --- |
| `userId` | `X-Soat-Context-UserId` |
| `tenantId` | `X-Soat-Context-TenantId` |
| `actorExternalId` | `X-Soat-Context-ActorExternalId` |
| `actor_external_id` | `X-Soat-Context-Actor_external_id` |
| `actor-external-id` | `X-Soat-Context-Actor-external-id` |
| `actor.external.id` | `X-Soat-Context-Actor.external.id` |
| `env` | `X-Soat-Context-Env` |

This is **not** title-casing: separators are not collapsed and later characters are never re-cased. `actor_external_id` yields `X-Soat-Context-Actor_external_id`, not `X-Soat-Context-ActorExternalId` — the two are different keys and produce different headers.

**Keys are never case-converted.** Unlike every other field in the REST API, `tool_context` keys are not rewritten between snake_case and camelCase: a key is an HTTP header name, not a SOAT field name, so it is stored, echoed in responses, and forwarded exactly as you wrote it — on REST, in formation templates, and over MCP alike. The one table above is enough to predict the header on any surface, and reading a session's `tool_context` and sending it back unchanged is lossless.

:::note Changed in a recent release

`tool_context` keys used to be case-converted like any other body field, so a `actor_external_id` sent over REST was stored as `actorExternalId` and produced `X-Soat-Context-ActorExternalId`. If a tool endpoint of yours reads a camelCase context header that it receives from an explicitly-set snake_case key, either rename the key to camelCase or read the snake_case header. Session-auto-populated keys (`sessionId` / `actorId` / `actorExternalId`) are unaffected — they were and remain camelCase.

:::

## Auto-populated keys (sessions)

When a generation runs through a [session](../modules/sessions.md), the server injects these keys automatically:

| Injected key | Forwarded header | Value |
| --- | --- | --- |
| `sessionId` | `X-Soat-Context-SessionId` | Public ID of the session; always present |
| `actorId` | `X-Soat-Context-ActorId` | Public ID of the session's actor; omitted if not set |
| `actorExternalId` | `X-Soat-Context-ActorExternalId` | `external_id` of the session's actor; omitted if not set |

You do not need to set these yourself — a session-backed generation already carries them.

### Precedence

Later wins, so a caller can override an auto-populated value:

```
auto-populated  <  session tool_context  <  per-request tool_context
```

## Validation

A key becomes an HTTP header name, so it must be a valid one. A request whose `tool_context` violates either rule below is rejected with **`400 INVALID_TOOL_CONTEXT_KEY`** at write time (`create-session`, `update-session`) or before the provider call (generation endpoints):

1. **Character set** — a key may contain only letters, digits and ``!#$%&'*+-.^_`|~``. A key with a space, colon, parenthesis, newline or non-ASCII character is rejected. (`meta.keys` lists the offending keys.)
2. **No collisions** — two keys must not map to the same header name. Header names are case-insensitive, so `userId` and `UserId` both resolve to `X-Soat-Context-UserId`; one value would be silently dropped. (`meta.header` names the colliding header.)

There is no length or total-header-bytes limit enforced by SOAT; the receiving server's own header limits apply.

## Security

The forwarded headers are the point: a tool endpoint can trust them in a way it cannot trust the prompt. Two things to keep in mind.

**Verify the caller.** Any client that can reach your tool endpoint can set an `X-Soat-Context-*` header by hand. The headers are trustworthy only if the endpoint also authenticates the request as coming from SOAT (a shared secret in `execute.headers`, mTLS, or network-level restriction). Treat them as *attested by SOAT*, not as *unforgeable*.

**Mind what egresses.** Every value is transmitted to every `http` and `mcp` tool the agent calls, including endpoints you do not control. This applies to the auto-populated `actorExternalId`: if an [Actor](../modules/actors.md)'s `external_id` holds a phone number or an email address, that PII reaches every third-party tool endpoint in the agent's tool set. When the tool set includes third-party endpoints, prefer an opaque internal identifier as `external_id` and correlate to the real contact detail on your own side.

## Example

```bash
soat create-session \
  --agent-id agent_01 \
  --actor-id actor_01 \
  --tool-context '{"tenantId":"acme","plan":"pro"}'
```

Every `http` tool call in that session then receives:

```http
X-Soat-Context-SessionId: sess_01
X-Soat-Context-ActorId: actor_01
X-Soat-Context-ActorExternalId: +5511999999999
X-Soat-Context-TenantId: acme
X-Soat-Context-Plan: pro
```
