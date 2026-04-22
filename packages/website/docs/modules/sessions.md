---
sidebar_position: 11
---

# Sessions

## Overview

Sessions provide a simplified **1 user ↔ 1 agent** conversational interface. They are a sub-resource of [Agents](./agents.md), nested under `/agents/:agentId/sessions`, and hide the underlying Conversation, Actor, and generation plumbing.

With sessions, interacting with an agent is reduced to three API calls:

1. **Create a session** — `POST /agents/:agentId/sessions`
2. **Save a user message** — `POST /agents/:agentId/sessions/:sessionId/messages` (returns 201, does not trigger generation)
3. **Generate a response** — `POST /agents/:agentId/sessions/:sessionId/generate` (triggers the LLM, returns the assistant reply)

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

## Data Model

### Session

| Field            | Type   | Description                                    |
| ---------------- | ------ | ---------------------------------------------- |
| `id`             | string | Public identifier prefixed with `sess_`        |
| `agentId`        | string | Public ID of the agent this session belongs to |
| `conversationId` | string | Public ID of the underlying conversation       |
| `status`         | string | `open` (default) or `closed`                   |
| `name`           | string | Optional display name                          |
| `actorId`        | string | Public ID of the user actor (`actr_` prefix)   |
| `tags`           | object | Free-form key-value metadata                   |
| `createdAt`      | string | ISO 8601 creation timestamp                    |
| `updatedAt`      | string | ISO 8601 last-updated timestamp                |

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

### Concurrency guard

Both sync and async calls go through the same concurrency guard: if `generatingAt` is set and less than 5 minutes have elapsed, generation is rejected as already in progress.

- **Sync**: returns `409 Conflict` to the caller.
- **Async**: the duplicate generation is silently dropped (the 202 response is still returned, but no LLM call is made). Any user message that was already saved via `POST .../messages` remains in the conversation history — it will simply have no assistant reply until the caller issues a new `POST .../generate` after the current generation completes.

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

All events include `sessionId`. Generation events additionally include `generationId` and `traceId` in the `data` payload.

Permissions are namespaced under `agents:` since sessions are an agent sub-resource.
