import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Sessions

## Overview

Sessions provide a simplified **1 user ↔ 1 agent** conversational interface. They are a sub-resource of [Agents](./agents.md), nested under `/agents/:agent_id/sessions`, and hide the underlying Conversation, Actor, and generation plumbing.

By default, interacting with an agent requires three API calls:

1. **Create a session** — `POST /agents/:agent_id/sessions`
2. **Save a user message** — `POST /agents/:agent_id/sessions/:session_id/messages` with either `message` or `document_id` (returns 201, does not trigger generation)
3. **Generate a response** — `POST /agents/:agent_id/sessions/:session_id/generate` (triggers the LLM, returns the assistant reply)

When `auto_generate` is enabled on the session, step 3 is handled automatically — `POST .../messages` saves the message and returns the assistant reply in one call, reducing the flow to two API calls.

The session automatically creates and manages the underlying conversation. An optional `actor_id` can be supplied to associate an existing Actor as the session owner; if omitted the session is created with no actor.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Key Concepts

### How Sessions Relate to Other Concepts

| Concept           | Relationship                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Chats**         | Raw LLM completions — no agents, no tools, caller manages history                   |
| **Sessions**      | 1 user ↔ 1 agent — full tool support, automatic history, nested under agents        |
| **Conversations** | Multi-party dialogue engine — powers sessions internally, available as escape hatch |

### Lifecycle

A session starts in `open` status. It can be updated to `closed` when the interaction is complete. Deleting a session cascades to the underlying conversation.

### Actor ID

The optional `actor_id` field associates an existing [Actor](./actors.md) as the owner of the session. When omitted, `actor_id` is `null` and no actor is created automatically. Sessions can be filtered by this field.

### Tags

Sessions support arbitrary key-value metadata via the `tags` JSONB field. Tags can be fully replaced (`PUT .../tags`) or merged (`PATCH .../tags`).

### Escape Hatch

Each session exposes its `conversation_id`, allowing advanced users to drop into the full [Conversations](./conversations.md) API when multi-party or lower-level control is needed.

### Auto-Generate

When `auto_generate` is set to `true` on a session, `POST .../messages` saves the user message **and** automatically triggers LLM generation in the same request. The response body contains the assistant reply instead of just the saved user message.

This collapses the three-call flow into two calls: create a session, then send messages.

`auto_generate` defaults to `false`. It can be set at session creation or toggled at any time:

```http
PATCH /agents/:agent_id/sessions/:session_id
Content-Type: application/json

{ "auto_generate": false }
```

The explicit `POST .../generate` endpoint continues to work regardless of this setting. Async generation (`?async=true`) is also supported on `POST .../messages` when `auto_generate` is enabled — the request returns `202 Accepted` immediately and generation proceeds in the background.

### Tool Context

Sessions support the same `tool_context` mechanism as direct agent generations — see [Tool Context](./agents.md#tool-context) in the Agents module for the full specification.

Session message creation does not support `tool_output` message content. If you need pre-generation tool execution with `output_path` extraction, call [Agents generation](./agents.md#tool-output-message-content) directly.

#### Auto-Populated Headers

When a generation is triggered through a session (either via `POST .../generate` or auto-generate), the server automatically injects the following keys into `tool_context` before forwarding to tool calls:

| Injected `tool_context` key | Forwarded header                 | Value                                                             |
| --------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `actorId`                   | `X-Soat-Context-ActorId`         | Public ID of the session's actor (`actr_...`); omitted if not set |
| `actorExternalId`           | `X-Soat-Context-ActorExternalId` | External ID of the session's actor; omitted if not set            |
| `sessionId`                 | `X-Soat-Context-SessionId`       | Public ID of the session (`sess_...`); always present             |

Any values provided by the caller in `tool_context` are merged on top and take precedence over the auto-populated values.

#### Example

Adding a caller-supplied `tenantId` alongside the automatically injected session fields:

```json
{
  "tool_context": {
    "tenantId": "tenant_xyz"
  }
}
```

The tool will receive headers: `X-Soat-Context-SessionId`, `X-Soat-Context-TenantId`, and — if the session has an actor — `X-Soat-Context-ActorId` and `X-Soat-Context-ActorExternalId`.

#### Testing Without an Actor

When testing sessions directly (without a channel webhook flow), the session may not have an actor attached. If your tools depend on `X-Soat-Context-ActorExternalId` or `X-Soat-Context-ActorId`, attach an actor at session creation time using `actor_id`:

```bash
# Create a session with an actor (actor must exist first)
soat create-agent-session --agent-id agt_01 --actor-id act_01
```

Alternatively, supply the missing context keys as per-request `tool_context` overrides on the generate call:

```json
{
  "tool_context": {
    "actorExternalId": "+15551234567",
    "actorId": "actr_abc123"
  }
}
```

This is useful for local testing where no actor record exists yet. The values you supply take precedence over any auto-populated values.

## Data Model

### Session

| Field             | Type           | Description                                                                                                    |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`              | string         | Public identifier prefixed with `sess_`                                                                        |
| `agent_id`        | string         | Public ID of the agent this session belongs to                                                                 |
| `conversation_id` | string         | Public ID of the underlying conversation                                                                       |
| `status`          | string         | `open` (default) or `closed`                                                                                   |
| `name`            | string         | Optional display name                                                                                          |
| `actor_id`        | string \| null | Optional public ID of the Actor associated with this session (`actr_` prefix); `null` when no actor is set     |
| `tags`            | object         | Free-form key-value metadata                                                                                   |
| `auto_generate`   | boolean        | When `true`, saving a message via `POST .../messages` automatically triggers LLM generation (default: `false`) |
| `created_at`      | string         | ISO 8601 creation timestamp                                                                                    |
| `updated_at`      | string         | ISO 8601 last-updated timestamp                                                                                |

### Message (within a session)

Messages are returned with simplified roles:

| Field        | Type   | Description                                                 |
| ------------ | ------ | ----------------------------------------------------------- |
| `role`       | string | `user` or `assistant` — stored on the message record itself |
| `content`    | string | Message text                                                |
| `model`      | string | Model used for assistant messages                           |
| `created_at` | string | ISO 8601 timestamp                                          |

When creating a session message (`POST .../messages`), send exactly one of:

- `message`: raw text body
- `document_id`: public ID of an existing document (its content is used as the message text)

## Examples

### Basic session flow

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-session --agent-id agt_01 --name "My Session"
soat add-session-message --agent-id agt_01 --session-id sess_01 --message "Hello!"
soat generate-session-response --agent-id agt_01 --session-id sess_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data: session } = await soat.sessions.createAgentSession({
  path: { agent_id: 'agt_01' },
  body: { name: 'My Session' },
});

await soat.sessions.addSessionMessage({
  path: { agent_id: 'agt_01', session_id: session.id },
  body: { message: 'Hello!' },
});

const { data: reply } = await soat.sessions.generateSessionResponse({
  path: { agent_id: 'agt_01', session_id: session.id },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/agents/agt_01/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Session"}'

curl -X POST https://api.example.com/api/v1/agents/agt_01/sessions/sess_01/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'

curl -X POST https://api.example.com/api/v1/agents/agt_01/sessions/sess_01/generate \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

## Async Generation

By default `POST .../generate` waits for the LLM to finish and returns the result synchronously. Pass `?async=true` to return immediately with a `202 Accepted` response:

```json
{ "status": "accepted", "session_id": "sess_..." }
```

### Concurrency and cancel-previous

Both sync and async calls go through the same concurrency handling. When a new generation request arrives while a previous one is still in-flight, the server **cancels the previous generation** and starts a fresh one. This ensures the model always sees the complete, up-to-date message history:

```
pos 0  user       "Hello"
pos 1  user       "What is 2+2?"
pos 2  user       "Are you sure?"   ← arrived while first generation was in-flight
pos 3  assistant  "Yes, 2+2 is definitely 4."  ← model saw all three messages
```

The cancel-previous mechanism uses an in-memory `AbortController` per session. Each process tracks active generations; the abort signal is threaded through to the underlying LLM call so that in-flight streaming or text generation is cancelled as soon as possible.

> **Trade-off:** Aborted generations still consume LLM tokens for the portion already processed before cancellation. For cost-sensitive workloads, consider rate-limiting generation requests.

> **Multi-replica deployments:** The in-memory abort map is per-process. In a multi-replica setup, a new generation request reaching a different replica will not cancel a generation running on another replica. The snapshot-position safety net still applies in that case.

If `generating_at` is set but no in-memory controller exists for the session (e.g., stale state after a process restart) and less than 5 minutes have elapsed, the generation is rejected as already in progress:

- **Sync**: returns `409 Conflict` to the caller.
- **Async**: the duplicate generation is silently dropped (the 202 response is still returned, but no LLM call is made).

### Message ordering with concurrent writes

Each conversation message is assigned a monotonically increasing `position`. When the assistant reply is written, it is inserted at the position that corresponds to the last message the model actually saw — not the position at write time. Any user messages that arrived while generation was in-flight are shifted up by one so that causal order is preserved:

```
pos 0  user    "Hello"
pos 1  user    "What is 2+2?"
pos 2  assistant  "4"          ← inserted at snapshot position + 1
pos 3  user    "Are you sure?" ← shifted up from 2 → 3 (arrived mid-generation)
```

A subsequent `POST .../generate` call therefore sees the latest user message at the end of the history and responds to it correctly.

## Webhook Events

The following events are dispatched to project webhooks as sessions change state:

| Event type                            | Trigger                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `sessions.created`                    | A new session is created                               |
| `sessions.updated`                    | A session's `name`, `status`, or `tags` are changed    |
| `sessions.deleted`                    | A session is deleted                                   |
| `sessions.generation.completed`       | LLM generation finished successfully                   |
| `sessions.generation.requires_action` | LLM returned a client-tool call requiring tool outputs |
| `sessions.generation.started`         | LLM generation has started for a session               |

All events include `session_id`. Generation events additionally include `generation_id` and `trace_id` in the `data` payload.

Permissions are namespaced under `agents:` since sessions are an agent sub-resource.
