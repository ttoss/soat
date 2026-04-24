---
sidebar_position: 11
---

# Sessions

## Overview

Sessions provide a simplified **1 user ↔ 1 agent** conversational interface. They are a sub-resource of [Agents](./agents.md), nested under `/agents/:agentId/sessions`, and hide the underlying Conversation, Actor, and generation plumbing.

By default, interacting with an agent requires three API calls:

1. **Create a session** — `POST /agents/:agentId/sessions`
2. **Save a user message** — `POST /agents/:agentId/sessions/:sessionId/messages` (returns 201, does not trigger generation)
3. **Generate a response** — `POST /agents/:agentId/sessions/:sessionId/generate` (triggers the LLM, returns the assistant reply)

When `autoGenerate` is enabled on the session, step 3 is handled automatically — `POST .../messages` saves the message and returns the assistant reply in one call, reducing the flow to two API calls.

The session automatically creates and manages the underlying conversation, agent actor, and user actor.

## Key Concepts

### How Sessions Relate to Other Concepts

| Concept           | Relationship                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Chats**         | Raw LLM completions — no agents, no tools, caller manages history                   |
| **Sessions**      | 1 user ↔ 1 agent — full tool support, automatic history, nested under agents        |
| **Conversations** | Multi-party dialogue engine — powers sessions internally, available as escape hatch |

### Lifecycle

A session starts in `open` status. It can be updated to `closed` when the interaction is complete. Deleting a session cascades to the underlying conversation and actors.

### Actor ID

The optional `actorId` field allows callers to reuse an existing Actor as the user for the session. When omitted, a new user actor is created automatically. Sessions can be filtered by this field.

### Tags

Sessions support arbitrary key-value metadata via the `tags` JSONB field. Tags can be fully replaced (`PUT .../tags`) or merged (`PATCH .../tags`).

### Escape Hatch

Each session exposes its `conversationId`, allowing advanced users to drop into the full [Conversations](./conversations.md) API when multi-party or lower-level control is needed.

### Auto-Generate

When `autoGenerate` is set to `true` on a session, `POST .../messages` saves the user message **and** automatically triggers LLM generation in the same request. The response body contains the assistant reply instead of just the saved user message.

This collapses the three-call flow into two calls: create a session, then send messages.

`autoGenerate` defaults to `false`. It can be set at session creation or toggled at any time:

```http
PATCH /agents/:agentId/sessions/:sessionId
Content-Type: application/json

{ "autoGenerate": false }
```

The explicit `POST .../generate` endpoint continues to work regardless of this setting. Async generation (`?async=true`) is also supported on `POST .../messages` when `autoGenerate` is enabled — the request returns `202 Accepted` immediately and generation proceeds in the background.

### Tool Context

Sessions support the same `toolContext` mechanism as direct agent generations — see [Tool Context](./agents.md#tool-context) in the Agents module for the full specification.

#### Auto-Populated Headers

When a generation is triggered through a session (either via `POST .../generate` or auto-generate), the server automatically injects the following keys into `toolContext` before forwarding to tool calls:

| Header                           | Value                                              |
| -------------------------------- | -------------------------------------------------- |
| `X-Soat-Context-ActorId`         | Public ID of the session's user actor (`actr_...`) |
| `X-Soat-Context-ActorExternalId` | External ID of the session's user actor            |
| `X-Soat-Context-SessionId`       | Public ID of the session (`sess_...`)              |

Any values provided by the caller in `toolContext` are merged on top and take precedence over the auto-populated values.

#### Example

Adding a caller-supplied `tenantId` alongside the automatically injected session fields:

```json
{
  "toolContext": {
    "tenantId": "tenant_xyz"
  }
}
```

The tool will receive all four headers: `X-Soat-Context-ActorId`, `X-Soat-Context-ActorExternalId`, `X-Soat-Context-SessionId`, and `X-Soat-Context-TenantId`.

## Data Model

### Session

| Field            | Type    | Description                                                                                                    |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `id`             | string  | Public identifier prefixed with `sess_`                                                                        |
| `agentId`        | string  | Public ID of the agent this session belongs to                                                                 |
| `conversationId` | string  | Public ID of the underlying conversation                                                                       |
| `status`         | string  | `open` (default) or `closed`                                                                                   |
| `name`           | string  | Optional display name                                                                                          |
| `actorId`        | string  | Public ID of the user actor (`actr_` prefix)                                                                   |
| `tags`           | object  | Free-form key-value metadata                                                                                   |
| `autoGenerate`   | boolean | When `true`, saving a message via `POST .../messages` automatically triggers LLM generation (default: `false`) |
| `createdAt`      | string  | ISO 8601 creation timestamp                                                                                    |
| `updatedAt`      | string  | ISO 8601 last-updated timestamp                                                                                |

### Message (within a session)

Messages are returned with simplified roles:

| Field       | Type   | Description                                         |
| ----------- | ------ | --------------------------------------------------- |
| `role`      | string | `user` or `assistant` (mapped from actor ownership) |
| `content`   | string | Message text                                        |
| `model`     | string | Model used for assistant messages                   |
| `createdAt` | string | ISO 8601 timestamp                                  |

## Permissions

| Action                            | Description                               |
| --------------------------------- | ----------------------------------------- |
| `agents:CreateSession`            | Create a new session for an agent         |
| `agents:ListSessions`             | List sessions for an agent                |
| `agents:GetSession`               | View a session and its messages           |
| `agents:UpdateSession`            | Update session name, status, or tags      |
| `agents:DeleteSession`            | Delete a session                          |
| `agents:SendSessionMessage`       | Save a user message or trigger generation |
| `agents:SubmitSessionToolOutputs` | Submit tool outputs for client tools      |
| `agents:ListSessionMessages`      | List messages in a session                |

## Async Generation

By default `POST .../generate` waits for the LLM to finish and returns the result synchronously. Pass `?async=true` to return immediately with a `202 Accepted` response:

```json
{ "status": "accepted", "sessionId": "sess_..." }
```

### Concurrency and cancel-previous

When a new generation request arrives while generation is already in progress for the same session, the server **cancels the in-flight generation** and starts a fresh one. This guarantees that the new generation always sees the full, up-to-date message history:

```
pos 0  user       "Hello"
pos 1  user       "What is 2+2?"
        ← generation starts here
pos 2  user       "Are you sure?"   ← arrives mid-generation
        ← first generation is aborted; new generation starts
pos 3  assistant  "Yes, 2+2 is definitely 4."
```

The cancellation is implemented with an in-memory `AbortController` map keyed by `${agentId}#${sessionId}`. The `AbortSignal` is threaded into the AI SDK call (`generateText`/`streamText`), so the LLM stream is terminated as soon as the signal fires. Any partial response from the cancelled generation is discarded.

> **Note:** The in-memory map is per-process. In a multi-replica deployment, a new request on a different replica cannot cancel a generation running on another replica. For multi-replica deployments, a distributed cancel signal (e.g., a Redis pub/sub channel) would be needed.

#### Fallback timeout guard

If no in-memory controller is found for a session but `generatingAt` is still set (e.g., after a process restart), the server falls back to a 5-minute timeout guard: if the elapsed time is less than 5 minutes, the new request is rejected with `409 Conflict`. This is a safety net against stale state; it does not affect the normal cancel-previous flow.

- **Sync**: a rejected request due to the fallback guard returns `409 Conflict`.
- **Async**: a rejected generation is silently dropped (the `202` response is still returned).

> **Note:** The guard is best-effort. Two simultaneous async requests arriving within the same milliseconds — before the first one writes `generatingAt` to the database — may both trigger generation. Use synchronous calls if strict single-generation semantics are required.

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

All events include `sessionId`. Generation events additionally include `generationId` and `traceId` in the `data` payload.

Permissions are namespaced under `agents:` since sessions are an agent sub-resource.
