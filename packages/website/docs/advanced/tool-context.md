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

Given a **stored** key, the header name is that key with its **first character uppercased** and `X-Soat-Context-` prepended. The rest of the key is used **verbatim**:

| Stored key | Forwarded header |
| --- | --- |
| `userId` | `X-Soat-Context-UserId` |
| `tenantId` | `X-Soat-Context-TenantId` |
| `actorExternalId` | `X-Soat-Context-ActorExternalId` |
| `actor-external-id` | `X-Soat-Context-Actor-external-id` |
| `actor.external.id` | `X-Soat-Context-Actor.external.id` |
| `env` | `X-Soat-Context-Env` |

This is **not** title-casing: separators are not collapsed and later characters are never re-cased. `actor_external_id` as a *stored* key yields `X-Soat-Context-Actor_external_id`, not `X-Soat-Context-ActorExternalId`.

### The stored key is not always the key you sent

On the REST API `tool_context` is an ordinary body field, so it goes through the usual snake_case → camelCase conversion the API applies to every request body — including its **inner keys**. The header is derived from the *stored* (camelCase) key, not from what you wrote in the request:

| Sent over REST | Stored | Forwarded header |
| --- | --- | --- |
| `actor_external_id` | `actorExternalId` | `X-Soat-Context-ActorExternalId` |
| `actorExternalId` | `actorExternalId` | `X-Soat-Context-ActorExternalId` |
| `user_id` | `userId` | `X-Soat-Context-UserId` |
| `actor-external-id` | `actor-external-id` | `X-Soat-Context-Actor-external-id` |
| `PascalKey` | `PascalKey` | `X-Soat-Context-PascalKey` |

So over REST, `snake_case` and `camelCase` spellings of the same key are equivalent — both land on the camelCase header. Only shapes the converter does not touch (kebab-case, dotted, leading uppercase) reach the header builder verbatim.

Two consequences worth knowing:

- **Formation templates are not converted.** A template's `tool_context` is a pass-through document, so `actor_external_id` there stays `actor_external_id` and produces `X-Soat-Context-Actor_external_id` — a *different* header than the same key sent over REST. Write formation `tool_context` keys in **camelCase** to match the REST behavior.
- **The response body is not a reliable preview of the header.** Responses convert camelCase back to snake_case, so a session created with `actorExternalId` reads back as `actor_external_id`, and a key with a leading uppercase (`PascalKey`) reads back with a leading underscore (`_pascal_key`). Neither changes the header that is actually sent; use the table above, not the response, to predict it.

To avoid all of this ambiguity: **use camelCase keys everywhere.** A camelCase key is stored, echoed and forwarded identically on every surface.

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
