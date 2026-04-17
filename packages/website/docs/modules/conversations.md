# Conversations Module

The Conversations module represents a multi-party dialogue within a project. A Conversation groups ordered messages, where each message is authored by an Actor — either a human contact (e.g. a WhatsApp user) or an AI-backed actor linked to an Agent or Chat.

## Overview

A Conversation belongs to a project and contains an ordered list of messages. Each message references a Document and is authored by an Actor. Actors are not tied 1:1 to agents: an Actor may optionally reference an `Agent` or a `Chat`, which allows it to generate the next message from the conversation history.

Conversations are identified by an `id` prefixed with `conv_`. The internal database primary key is never returned.

## Data Model

### Conversation

| Field       | Type   | Description                                        |
| ----------- | ------ | -------------------------------------------------- |
| `id`        | string | Public identifier prefixed with `conv_`            |
| `projectId` | string | ID of the owning project                           |
| `name`      | string | Optional human-readable title for the conversation |
| `status`    | string | Conversation status: `open` or `closed`            |
| `tags`      | object | Free-form string tags                              |
| `createdAt` | string | ISO 8601 creation timestamp                        |
| `updatedAt` | string | ISO 8601 last-updated timestamp                    |

A conversation does not store a single `actorId`. Actors participate by authoring messages. Use `GET /conversations/:id/actors` to list the distinct participants.

### Conversation Message

| Field        | Type    | Description                                                          |
| ------------ | ------- | -------------------------------------------------------------------- |
| `documentId` | string  | ID of the Document attached as a message                             |
| `actorId`    | string  | ID of the Actor who authored the message                             |
| `position`   | integer | Zero-based position of the message in the conversation               |
| `content`    | string  | Full text content of the message (read from the underlying document) |

The pair `(conversationId, position)` is uniquely indexed. See [Message ordering](#message-ordering) for insertion semantics.

## Key Concepts

### Actors, Agents, and Chats

`Actor`, `Agent`, and `Chat` are independent resources. See [Actors](./actors.md), [Agents](./agents.md), and [Chats](./chats.md) for their full data models.

- An **Actor** is a stable participant identity (name, type, `instructions`, tags). Always project-scoped.
- An **Agent** / **Chat** is an AI configuration (provider, model, base instructions, tools).
- An Actor **may** reference an `Agent` **or** a `Chat` (mutually exclusive) via `agentId` / `chatId`. Actors without either are plain human/external participants.

The relationship is **N:1** — one agent can back many actors.

#### Persona overrides

Each AI-backed Actor has an optional `instructions` field (TEXT). At generation time, the effective system prompt is composed:

```
<agent.instructions or chat.systemMessage>

<actor.instructions>

You are <actor.name>. Reply as this participant.
```

Empty sections are skipped. This lets one agent configuration power multiple distinct voices without cloning the agent.

#### Deletion rules

- Deleting an `Agent` or `Chat` sets `agentId` / `chatId` on referencing actors to `null`. The actor and its historical messages are preserved; the actor can no longer generate until re-linked.
- Deleting an `Actor` is **blocked** if any conversation message references it. Remove the actor's messages (or delete the containing conversations) first.

#### Convenience endpoints

`POST /agents/:id/actors` and `POST /chats/:id/actors` create a pre-linked actor in a single call. These require the `actors:CreateActor` permission on the agent/chat's project — no new permission is introduced.

### Messages

Messages are ordered, actor-authored references to Documents within a conversation. Each document can appear at most once per conversation — adding the same document twice returns `409 Conflict`.

When listing messages, each entry includes the full text `content` of the underlying document and the authoring `actorId`.

Removing a message from a conversation also deletes its underlying Document and the associated File on disk, preventing orphaned records.

#### Message ordering

The unique index `(conversationId, position)` enforces that no two messages share a slot.

- **Append** (default): if `position` is omitted, the new message is written at `MAX(position) + 1`.
- **Insert between**: if an explicit `position` collides with an existing message, all messages at `position` and after are shifted up by one in a single transaction, and the new message is inserted.
- **Concurrent writes**: two concurrent appends or inserts at the same `position` race on the unique index; the loser receives `409 Conflict` and must retry.

### Generating the Next Message

An AI-backed actor (one with `agentId` or `chatId`) can generate the next message from the conversation history:

```
POST /api/v1/conversations/:id/generate
{ "actorId": "act_...", "model": "gpt-4o-mini", "stream": false }
```

Flow:

1. Load all messages ordered by `position`.
2. Compose the effective system prompt (see [Persona overrides](#persona-overrides)).
3. Map each message to a model message: the generating actor's own prior messages become `assistant`, all other authors become `user`. `user` content is prefixed with the authoring actor's name (`"[Alice]: ..."`) to preserve multi-party attribution.
4. Dispatch to the Agents module (if the actor has `agentId`) or the Chats module (if it has `chatId`), reusing their generation plumbing — including agent tools and the `requires_action` client-tool flow.
5. On `completed`, a new Document is created and attached as the next message, authored by the generating actor. The response includes the new message plus `generationId` and `traceId`.
6. On `requires_action` (agent client tools only), no message is persisted yet. Submit outputs via `POST /agents/:id/generate/:generationId/tool-outputs`; the resolved message is persisted on completion.

Actors without `agentId` or `chatId` cannot generate and return `400`.

#### Concurrency

Generate calls acquire a per-conversation advisory lock for the duration of the request. Concurrent generate calls on the same conversation are serialized to prevent two assistant messages racing for the same `position`.

#### Streaming

With `"stream": true`, the response is a `text/event-stream` emitting incremental tokens. The new message is persisted **only after** the stream completes successfully; partial streams produce no message. The final SSE event carries the `documentId`, `generationId`, and `traceId`.

### Filtering by Actor

Use `GET /conversations?actorId=...` to list conversations in which the given actor has authored at least one message. This is evaluated via an `EXISTS` join on `conversation_messages` and is more expensive than the default listing.

### Future Extensions

The following are not implemented in v1 but the data model leaves room for them:

- **Auto-reply**: a per-conversation `autoRespondActorId` that triggers `POST /conversations/:id/generate` automatically whenever a message from a different actor is added. Intended for WhatsApp-style bot flows.
- **Structured personas**: richer persona metadata (voice, language, tone) on the Actor. For now, put these in `tags` and render them into `instructions` at the application layer.

### Status

A conversation transitions between `open` and `closed`. Use `PATCH /conversations/:id` to update the status. New conversations default to `open`.

## Permissions

Conversation operations are governed by per-project policies. Grant the following permissions:

| Action                           | Permission                                  | REST Endpoint                               | MCP Tool                        |
| -------------------------------- | ------------------------------------------- | ------------------------------------------- | ------------------------------- |
| List conversations               | `conversations:ListConversations`           | `GET /api/v1/conversations`                 | `list-conversations`            |
| Get conversation by ID           | `conversations:GetConversation`             | `GET /api/v1/conversations/:id`             | `get-conversation`              |
| List conversation messages       | `conversations:GetConversation`             | `GET /api/v1/conversations/:id/messages`    | `list-conversation-messages`    |
| List conversation actors         | `conversations:GetConversation`             | `GET /api/v1/conversations/:id/actors`      | `list-conversation-actors`      |
| Create conversation              | `conversations:CreateConversation`          | `POST /api/v1/conversations`                | `create-conversation`           |
| Update conversation status       | `conversations:UpdateConversation`          | `PATCH /api/v1/conversations/:id`           | `update-conversation`           |
| Add message to conversation      | `conversations:UpdateConversation`          | `POST /api/v1/conversations/:id/messages`   | `add-conversation-message`      |
| Remove message from conversation | `conversations:UpdateConversation`          | `DELETE /api/v1/conversations/:id/messages` | `remove-conversation-message`   |
| Generate next message            | `conversations:GenerateConversationMessage` | `POST /api/v1/conversations/:id/generate`   | `generate-conversation-message` |
| Delete conversation              | `conversations:DeleteConversation`          | `DELETE /api/v1/conversations/:id`          | `delete-conversation`           |
