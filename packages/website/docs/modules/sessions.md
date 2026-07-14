---
description: "A simplified one-user-to-one-agent conversational interface owned by an agent."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Sessions

A simplified 1 user ↔ 1 agent conversational interface, owned by an agent.

## Overview

Sessions hide the underlying [Conversation](./conversations.md), [Actor](./actors.md), and generation plumbing. By default, interacting with an agent requires three API calls: create a session, save a user message, and trigger generation. When `auto_generate` is enabled, the message and generation collapse into a single call. Walk through it end to end in [Chat with an LLM - Step 5 (Create a session)](/docs/tutorials/chat-with-llm#step-5--create-a-session) and [Step 6 (Send messages and receive replies)](/docs/tutorials/chat-with-llm#step-6--send-messages-and-receive-replies).

Sessions are a top-level resource at `/sessions`. Each session belongs to an [Agent](./agents.md) — set `agent_id` on create, and filter by it with `GET /sessions?agent_id=`. Each session exposes its `conversation_id` as an escape hatch to the full [Conversations](./conversations.md) API; list a session's messages via `GET /conversations/:conversation_id/messages` (this is governed by `conversations:GetConversation`, not the `agents:*` session actions).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 5 (Create a session)](/docs/tutorials/chat-with-llm#step-5--create-a-session)
- [Chat with an LLM - Step 6 (Send messages and receive replies)](/docs/tutorials/chat-with-llm#step-6--send-messages-and-receive-replies)
- [Debug Session, Generation, and Trace History - Step 4 (Retrieve the full session message timeline)](/docs/tutorials/debug-session-generation-trace-history#step-4---retrieve-the-full-session-message-timeline)

## Data Model

### Session

| Field                    | Type            | Description                                                                                                    |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                     | string          | Public identifier prefixed with `sess_`                                                                        |
| `agent_id`               | string          | Public ID of the agent this session belongs to                                                                 |
| `conversation_id`        | string          | Public ID of the underlying conversation                                                                       |
| `status`                 | string          | `open` (default), `closed`, or `expired`                                                                       |
| `name`                   | string          | Optional display name                                                                                          |
| `actor_id`               | string \| null  | Optional public ID of the [Actor](./actors.md) associated with this session (`actor_` prefix)                  |
| `tags`                   | object          | Free-form key-value metadata                                                                                   |
| `auto_generate`          | boolean         | When `true`, saving a message automatically triggers LLM generation (default: `false`)                         |
| `message_delay_seconds`  | integer \| null | Debounce delay in seconds before the LLM is called after a user message. `null` means no delay (default).      |
| `inactivity_ttl_seconds` | integer         | Seconds of inactivity before the session expires. `0` means never expires (default: `0`)                       |
| `last_activity_at`       | string \| null  | ISO 8601 timestamp of the last user message; `null` until the first message is added                           |
| `created_at`             | string          | ISO 8601 creation timestamp                                                                                    |
| `updated_at`             | string          | ISO 8601 last-updated timestamp                                                                                |

### Message (within a session)

| Field        | Type   | Description                                                 |
| ------------ | ------ | ----------------------------------------------------------- |
| `role`       | string | `user` or `assistant`                                       |
| `content`    | string | Message text                                                |
| `model`      | string | Model used for assistant messages                           |
| `created_at` | string | ISO 8601 timestamp                                          |

When creating a session message (`POST .../messages`), send exactly one of:

- `message`: raw text body
- `document_id`: public ID of an existing document (its content is used as the message text)

An optional `idempotency_key` string can be included with either variant — see [Idempotency](#idempotency).

## Key Concepts

### How Sessions Relate to Other Concepts

| Concept           | Relationship                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Chats**         | Raw LLM completions — no agents, no tools, caller manages history                   |
| **Sessions**      | 1 user ↔ 1 agent — full tool support, automatic history, owned by an agent          |
| **Conversations** | Multi-party dialogue engine — powers sessions internally, available as escape hatch |

### Lifecycle

A session starts in `open` status. It can be updated to `closed` when the interaction is complete. If `inactivity_ttl_seconds` is configured, the status transitions to `expired` lazily when the session is next fetched or listed after the TTL elapses. See [Deletion](#deletion) for what happens when a session is deleted.

### Deletion

`DELETE .../sessions/:session_id` removes the session row and its underlying [Conversation](./conversations.md) row in the same transaction. Deleting the conversation cascades at the database level to every [message](#message-within-a-session) in it.

What deletion does **not** remove:

- **The session's actor.** The [Actor](./actors.md) referenced by `actor_id` is left untouched and can still be looked up or reused by other sessions.
- **Documents backing message content.** Each message's content is stored in a [Document](./documents.md) row; deleting the session does not delete these documents (or their underlying files), so they remain in place after the session and its messages are gone.
- **Generations and traces.** A session's [generations and traces](./traces.md#debugging-joins-trace-generation-session) are not linked to the session or conversation record, so they are unaffected by session deletion and remain queryable via `GET /api/v1/traces/{trace_id}` after the session no longer exists.

Delete these resources explicitly beforehand if you need a full cleanup.

### Auto-Generate

When `auto_generate` is `true`, `POST .../messages` saves the user message **and** automatically triggers LLM generation in the same request. The response body contains the assistant reply instead of just the saved user message.

This collapses the three-call flow into two calls: create a session, then send messages.

`auto_generate` defaults to `false`. It can be set at session creation or toggled at any time:

```http
PATCH /sessions/:session_id
Content-Type: application/json

{ "auto_generate": false }
```

The explicit `POST .../generate` endpoint continues to work regardless of this setting. Async generation (`?async=true`) is also supported on `POST .../messages` when `auto_generate` is enabled.

### Message Delay (Debounce)

When `message_delay_seconds` is set, `POST .../messages` does **not** trigger LLM generation immediately. A timer starts and resets with each new message. The LLM is only called after the configured delay elapses with no new messages.

```http
POST /sessions
Content-Type: application/json

{ "agent_id": "agent_01", "auto_generate": true, "message_delay_seconds": 3 }
```

With the above:
- User sends "What's the" → timer starts (3 s)
- User sends "weather in" → timer resets (3 s)
- User sends "Paris?" → timer resets (3 s)
- 3 seconds of silence → LLM is called with all three messages in context

`POST .../messages` always returns immediately with the saved user message, regardless of the delay setting. Generation fires asynchronously after the delay elapses.

`message_delay_seconds` has no effect when `auto_generate` is `false` or when a generation is already in progress.

### Single Session Per Actor

When the parent agent has `single_session_per_actor: true`, creating a session with an `actor_id` returns `409 Conflict` if an open session for that actor already exists. The error body includes `meta.session_id` with the existing session's ID. See [Single Session Per Actor](./agents.md#single-session-per-actor) on the Agents module.

### Idempotency

Channels like WhatsApp use at-least-once webhook delivery — the same inbound message may arrive multiple times. Pass `idempotency_key` in the `POST .../messages` body to deduplicate:

```json
{
  "message": "Hello",
  "idempotency_key": "wamid.HBgLNTUxMTk4..."
}
```

- **First call** — message is saved and generation is triggered if `auto_generate` is on. Returns `201 Created`.
- **Subsequent calls with the same key** — returns the original message with `200 OK`. No new message or generation is created.

The key is scoped to the session.

### Inactivity TTL

Sessions can expire automatically after a period of inactivity using `inactivity_ttl_seconds`.

- **`0` (default)** — the session never expires.
- **Positive integer** — the session expires if no user message has been added for that many seconds since `last_activity_at`.

When a session exceeds its TTL, its `status` is lazily updated to `expired` the next time it is fetched or listed. Once expired, `POST .../generate` returns `410 Gone` with error code `SESSION_EXPIRED`. Open a fresh session to continue.

The TTL is stored server-side at session creation and persists without requiring the client to re-send it. It can also be updated at any time via `PATCH .../sessions/:session_id` — the inactivity clock continues from the last `last_activity_at` timestamp, so changing the TTL takes effect on the next fetch.

```json
HTTP 410 Gone
{
  "error": {
    "code": "SESSION_EXPIRED",
    "message": "The session has expired due to inactivity."
  }
}
```

### Tool Context

Sessions support the same `tool_context` mechanism as direct agent generations — see [Tool Context](./agents.md#tool-context) in the Agents module.

When a generation is triggered through a session, the server automatically injects the following keys into `tool_context`:

| Injected key        | Forwarded header                 | Value                                                             |
| ------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `actorId`           | `X-Soat-Context-ActorId`         | Public ID of the session's actor; omitted if not set             |
| `actorExternalId`   | `X-Soat-Context-ActorExternalId` | External ID of the session's actor; omitted if not set            |
| `sessionId`         | `X-Soat-Context-SessionId`       | Public ID of the session; always present                          |

Any values provided by the caller in `tool_context` take precedence over the auto-populated values.

### Async Generation

Pass `?async=true` to `POST .../generate` to return immediately with `202 Accepted`:

```json
{ "status": "accepted", "session_id": "sess_..." }
```

When a new generation request arrives while a previous one is still in-flight, the server **cancels the previous generation** and starts a fresh one so the model always sees the complete, up-to-date message history.

### Debugging (Session, Generation, Trace)

Each call to `POST .../generate` returns `generation_id` and `trace_id`. Store these alongside `session_id` for debugging:

```json
{
  "session_id": "sess_...",
  "generation_id": "gen_...",
  "trace_id": "trace_...",
  "created_at": "2026-06-01T12:34:56.000Z"
}
```

- `GET .../sessions/{session_id}/messages` returns the conversation timeline — see [Debug Session, Generation, and Trace History - Step 4 (Retrieve the full session message timeline)](/docs/tutorials/debug-session-generation-trace-history#step-4---retrieve-the-full-session-message-timeline).
- `GET /api/v1/traces/{trace_id}` returns the execution trace.
- `GET /api/v1/traces/{trace_id}/tree` returns the full trace tree for nested agent calls.

See [Traces](./traces.md#debugging-joins-trace-generation-session) for the full correlation strategy.

### Webhook Events

The following events are dispatched to project webhooks as sessions change state:

| Event type                            | Trigger                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `sessions.created`                    | A new session is created                               |
| `sessions.updated`                    | A session's `name`, `status`, or `tags` are changed    |
| `sessions.deleted`                    | A session is deleted                                   |
| `sessions.generation.completed`       | LLM generation finished successfully                   |
| `sessions.generation.requires_action` | LLM returned a client-tool call requiring tool outputs |
| `sessions.generation.started`         | LLM generation has started for a session               |

All events include `session_id`. Generation events additionally include `generation_id` and `trace_id`. Permissions are namespaced under `agents:` since each session belongs to an agent.

## Examples

### Basic session flow

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-session --agent-id agent_01 --name "My Session"
soat add-session-message --session-id sess_01 --message "Hello!"
soat generate-session-response --session-id sess_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data: session } = await soat.sessions.createSession({
  body: { agent_id: 'agent_01', name: 'My Session' },
});

await soat.sessions.addSessionMessage({
  path: { session_id: session.id },
  body: { message: 'Hello!' },
});

const { data: reply } = await soat.sessions.generateSessionResponse({
  path: { session_id: session.id },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "agent_01", "name": "My Session"}'

curl -X POST https://api.example.com/api/v1/sessions/sess_01/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'

curl -X POST https://api.example.com/api/v1/sessions/sess_01/generate \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### List sessions

Filter by agent, actor, or status.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-sessions --agent-id agent_01 --status open
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sessions } = await soat.sessions.listSessions({
  query: { agent_id: 'agent_01', status: 'open' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/sessions?agent_id=agent_01&status=open" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
