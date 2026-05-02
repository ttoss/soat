import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Conversations

The Conversations module represents a multi-party dialogue within a project. A Conversation groups ordered messages, each carrying an explicit `role` (`user`, `assistant`, or `system`) and an optional reference to an [Actor](./actors.md) for authorship tracking.

## Overview

A Conversation belongs to a project and contains an ordered list of messages. Each message references a [Document](./documents.md), has a `role`, and optionally references an [Actor](./actors.md) as its author.

Conversations are identified by an `id` prefixed with `conv_`. The internal database primary key is never returned.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Conversation

| Field        | Type   | Description                                                        |
| ------------ | ------ | ------------------------------------------------------------------ |
| `id`         | string | Public identifier prefixed with `conv_`                            |
| `project_id` | string | ID of the owning project                                           |
| `name`       | string | Optional human-readable title for the conversation                 |
| `status`     | string | Conversation status: `open` or `closed`                            |
| `actor_id`   | string | Optional ID of the Actor who **owns** this conversation (nullable) |
| `tags`       | object | Free-form string tags                                              |
| `created_at` | string | ISO 8601 creation timestamp                                        |
| `updated_at` | string | ISO 8601 last-updated timestamp                                    |

`actor_id` identifies the **owner** of the conversation — typically the external contact who initiated the thread (e.g. a WhatsApp contact). This is a direct ownership reference set at creation time and is distinct from message authorship: multiple actors can still participate by sending messages. Use `GET /conversations/:id/actors` to list all distinct message participants.

### Conversation Message

| Field         | Type           | Description                                                                                                                |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `document_id` | string         | ID of the Document attached as a message                                                                                   |
| `role`        | string         | Role of the message: `user`, `assistant`, or `system`                                                                      |
| `actor_id`    | string \| null | Optional ID of the Actor who authored the message; `null` for messages not tied to an actor                                |
| `agent_id`    | string \| null | Optional ID of the Agent that generated this message; `null` for non-generated messages                                    |
| `position`    | integer        | Zero-based position of the message in the conversation                                                                     |
| `metadata`    | object \| null | Optional structured key-value data attached to the message (e.g. `phone`, `channel`). Injected into the AI prompt context. |
| `content`     | string         | Full text content of the message (read from the underlying document)                                                       |

The pair `(conversation_id, position)` is uniquely indexed. See [Message ordering](#message-ordering) for insertion semantics.

## Key Concepts

### Actors, Agents, and Chats

`Actor`, `Agent`, and `Chat` are independent resources. See [Actors](./actors.md), [Agents](./agents.md), and [Chats](./chats.md) for their full data models.

- An **Actor** is a stable participant identity (name, type, `instructions`, tags). Always project-scoped.
- An **Agent** / **Chat** is an AI configuration (provider, model, base instructions, tools).
- An Actor **may** reference an `Agent` **or** a `Chat` (mutually exclusive) via `agent_id` / `chat_id`. Actors without either are plain human/external participants.

Actors are used to track _who_ wrote a message (authorship). Generation is triggered separately by passing `agent_id` directly to `POST /conversations/:id/generate` — no actor is required to drive generation.

#### Deletion rules

- Deleting an `Agent` or `Chat` sets `agent_id` / `chat_id` on referencing actors to `null`. The actor and its historical messages are preserved.
- Deleting an `Actor` is **blocked** if any conversation message references it. Remove the actor's messages (or delete the containing conversations) first.

#### Convenience endpoints

`POST /agents/:id/actors` and `POST /chats/:id/actors` create a pre-linked actor in a single call. These require the `actors:CreateActor` permission on the agent/chat's project — no new permission is introduced.

### Messages

Messages are ordered references to Documents within a conversation. Each message has a `role` (`user`, `assistant`, or `system`) and an optional `actor_id` for authorship tracking. Each document can appear at most once per conversation — adding the same document twice returns `409 Conflict`.

When listing messages, each entry includes the full text `content` of the underlying document, the message `role`, the optional authoring `actor_id`, and the optional `agent_id` of the Agent that generated it (set for `assistant` messages produced by `POST /conversations/:id/generate`, `null` otherwise).

Removing a message from a conversation also deletes its underlying Document and the associated File on disk, preventing orphaned records.

#### Message ordering

The unique index `(conversation_id, position)` enforces that no two messages share a slot.

- **Append** (default): if `position` is omitted, the new message is written at `MAX(position) + 1`.
- **Insert between**: if an explicit `position` collides with an existing message, all messages at `position` and after are shifted up by one in a single transaction, and the new message is inserted.
- **Concurrent writes**: two concurrent appends or inserts at the same `position` race on the unique index; the loser receives `409 Conflict` and must retry.

### Generating the Next Message

Any [Agent](./agents.md) can generate the next message from the conversation history:

```
POST /api/v1/conversations/:id/generate
{ "agent_id": "agt_...", "stream": false }
```

Flow:

1. Load all messages ordered by `position`.
2. Compose the effective system prompt from the agent's `instructions`.
3. Map each message to a model message using the stored `role` field. Messages with `role: 'assistant'` become assistant turns; all others become user turns.
4. Dispatch to the Agents module, reusing its generation plumbing — including agent tools and the `requires_action` client-tool flow.
5. On `completed`, a new Document is created and attached as the next message with `role: 'assistant'`. The response includes:
   - **`content`** — the AI-generated text of the reply (the canonical field; always a `string`).
   - `message` — the persisted `ConversationMessageRecord` (`document_id`, `role`, `actor_id`, `agent_id`, `position`, `content`). `agent_id` is set to the ID of the generating agent.
   - `generation_id` and `trace_id` for observability.
   - `model` — the model name used for this generation.

   ```ts
   const { data } = await soat.POST(
     '/api/v1/conversations/{conversation_id}/generate',
     {
       params: { path: { conversation_id } },
       body: { agent_id: agentId },
     }
   );
   // data.content is always the AI-generated text when data.status === 'completed'
   const responseText = data?.content;
   ```

6. On `requires_action` (agent client tools only), no message is persisted yet. Submit outputs via `POST /agents/:id/generate/:generation_id/tool-outputs`; the resolved message is persisted on completion.

#### Concurrency

Generate calls acquire a per-conversation advisory lock for the duration of the request. Concurrent generate calls on the same conversation are serialized to prevent two assistant messages racing for the same `position`.

#### Streaming

With `"stream": true`, the response is a `text/event-stream` emitting incremental tokens. The new message is persisted **only after** the stream completes successfully; partial streams produce no message. The final SSE event carries the `document_id`, `generation_id`, and `trace_id`.

### Tool Context

`POST /api/v1/conversations/:id/generate` accepts an optional `tool_context` field in the request body. The context is forwarded to the underlying agent generation exactly as described in [Tool Context](./agents.md#tool-context) in the Agents module.

```json
{
  "agent_id": "agt_...",
  "tool_context": {
    "user_id": "usr_abc123",
    "tenant_id": "tenant_xyz"
  }
}
```

### Filtering by Actor

Use `GET /conversations?actor_id=...` to list conversations in which the given actor has authored at least one message. This is evaluated via an `EXISTS` join on `conversation_messages` and is more expensive than the default listing.

### Future Extensions

The following are not implemented in v1 but the data model leaves room for them:

- **Auto-reply**: a per-conversation `auto_respond_actor_id` that triggers `POST /conversations/:id/generate` automatically whenever a message from a different actor is added. Intended for WhatsApp-style bot flows.
- **Structured personas**: richer persona metadata (voice, language, tone) on the Actor. For now, put these in `tags` and render them into `instructions` at the application layer.

### Status

A conversation transitions between `open` and `closed`. Use `PATCH /conversations/:id` to update the status. New conversations default to `open`.

## Examples

### Create a conversation and add a message

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-conversation --project-id proj_ABC --name "Support Thread"
soat add-conversation-message \
  --conversation-id conv_01 \
  --content "Hello, I need help." \
  --role user
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

const { data: conv } = await soat.conversations.createConversation({
  body: { project_id: 'proj_ABC', name: 'Support Thread' },
});

const { data: msg } = await soat.conversations.addConversationMessage({
  path: { conversation_id: conv.id },
  body: { content: 'Hello, I need help.', role: 'user' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/conversations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_ABC", "name": "Support Thread"}'

curl -X POST https://api.example.com/api/v1/conversations/conv_01/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello, I need help.", "role": "user"}'
```

</TabItem>
</Tabs>

### Generate the next message

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat generate-conversation-message \
  --conversation-id conv_01 \
  --agent-id agt_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data: reply } = await soat.conversations.generateConversationMessage({
  path: { conversation_id: 'conv_01' },
  body: { agent_id: 'agt_01' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/conversations/conv_01/generate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "agt_01"}'
```

</TabItem>
</Tabs>
