---
description: "Multi-party dialogues that group ordered, role-tagged messages with optional actor authorship within a SOAT project."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Conversations

A Conversation is a multi-party dialogue within a project: ordered messages, each with a `role` (`user` or `assistant`) and an optional authoring [Actor](./actors.md).

## Overview

Each message references a [Document](./documents.md), has a `role`, and optionally an [Actor](./actors.md) author. Ids are prefixed `conv_`; the internal primary key is never returned.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 7 (View the conversation history)](/docs/tutorials/chat-with-llm#step-7--view-the-conversation-history)
- [Connect Third-Party LLMs - Step 6 (Start a conversation)](/docs/tutorials/connect-third-party-llms#step-6--start-a-conversation)
- [Debug Session, Generation, and Trace History - Step 4 (Retrieve the full session message timeline)](/docs/tutorials/debug-session-generation-trace-history#step-4---retrieve-the-full-session-message-timeline)

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

`actor_id` is the conversation **owner** (typically the external contact who initiated it, e.g. a WhatsApp contact), set at creation and distinct from message authorship; other actors can still send messages. List distinct participants with [`GET /actors?conversation_id=...`](/docs/api/actors/list-actors).

### Conversation Message

| Field         | Type           | Description                                                                                                                |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `document_id` | string         | ID of the Document attached as a message                                                                                   |
| `role`        | string         | Role of the message: `user` or `assistant` — `system` is refused with `400 SYSTEM_MESSAGE_NOT_ALLOWED` |
| `actor_id`    | string \| null | Optional ID of the Actor who authored the message; `null` for messages not tied to an actor                                |
| `agent_id`    | string \| null | Optional ID of the Agent that generated this message; `null` for non-generated messages                                    |
| `position`    | integer        | Zero-based position of the message in the conversation                                                                     |
| `metadata`    | object \| null | Optional structured key-value data attached to the message (e.g. `phone`, `channel`). Injected into the AI prompt context. |
| `content`     | string         | Full text content of the message (read from the underlying document)                                                       |

The pair `(conversation_id, position)` is uniquely indexed. See [Message ordering](#message-ordering) for insertion semantics.

## Key Concepts

### Actors, Agents, and Chats

[Actors](./actors.md) track authorship; generation is triggered by passing `agent_id` to [`POST /conversations/:id/generate`](/docs/api/conversations/generate-conversation-message) and needs no actor. Linking and deletion rules: [Agent and Chat Linking](./actors.md#agent-and-chat-linking). Deleting an Actor is **blocked** while any conversation message references it.

### Messages

Messages are ordered Document references with a `role` and optional `actor_id`. A document may appear once per conversation; adding it twice returns `409 Conflict`.

`role: "system"` is refused with `400 SYSTEM_MESSAGE_NOT_ALLOWED`: stored history feeds [agent generations](./agents.md#instructions), so a system entry would let conversation data rewrite the agent's prompt. System content belongs in the agent's `instructions` or the [actor persona](./actors.md).

Listed messages carry the document's full `content`, `role`, `actor_id`, and `agent_id` (set on `assistant` messages produced by [`POST /conversations/:id/generate`](/docs/api/conversations/generate-conversation-message), `null` otherwise). Example: [Chat with an LLM - Step 7 (View the conversation history)](/docs/tutorials/chat-with-llm#step-7--view-the-conversation-history).

Removing a message also deletes its Document and File.

### Tags

Key-value string pairs managed via the tag sub-endpoints and matched by `soat:ResourceTag/<key>`. [`GET /api/v1/conversations`](/docs/api/conversations/list-conversations) filters by pair with `?tags=key:value` (repeatable, all must match). See [IAM — Tags](iam.md#tags).

Tool-call chains (invocations and results alongside the final text) are preserved internally so later turns see the full exchange; this state is separate from `metadata` and never returned.

#### Message ordering

No two messages share a slot:

- **Append** (default): omitted `position` writes at `MAX(position) + 1`.
- **Insert between**: a colliding `position` shifts that message and all after it up by one in a single transaction.
- **Concurrent writes** at the same `position` race on the unique index; the loser gets `409 Conflict` and retries.

### Generating the Next Message

Any [Agent](./agents.md) can generate the next message from the history. Provider-backed example: [Connect Third-Party LLMs - Step 6 (Start a conversation)](/docs/tutorials/connect-third-party-llms#step-6--start-a-conversation).

```
POST /api/v1/conversations/:id/generate?wait=true
{ "agent_id": "agent_...", "stream": false }
```

By default the call runs in the background and returns `202 Accepted` (`{ "status": "accepted", "conversation_id": "conv_..." }`); poll [`GET /conversations/:id/messages`](/docs/api/conversations/list-conversation-messages) for the reply. The agent is resolved **synchronously**, so an unknown `agent_id` is a `404`.

`?wait=true` blocks and returns the result inline; it is required to observe `requires_action` (client tools). See [Synchronous & Asynchronous Execution](../advanced/sync-and-async.md) for the platform-wide `wait` contract.

Flow (with `?wait=true`):

1. Load messages ordered by `position`.
2. Compose the system prompt from the agent's `instructions`.
3. Map `role: 'assistant'` messages to assistant turns; all others to user turns.
4. Dispatch to the Agents module, including agent tools and the `requires_action` client-tool flow.
5. On `completed`, a new Document is attached as the next message with `role: 'assistant'`. The response includes:
   - **`content`** — the generated text (always a `string`).
   - `message` — the persisted `ConversationMessageRecord` (`document_id`, `role`, `actor_id`, `agent_id`, `position`, `content`); `agent_id` is the generating agent.
   - `generation_id` and `trace_id`.
   - `model` — the model used.

   ```ts
   const { data } = await soat.conversations.generateConversationMessage({
     path: { conversation_id },
     query: { wait: true },
     body: { agent_id: agentId },
   });
   // data.content is always the AI-generated text when data.status === 'completed'
   const responseText = data?.content;
   ```

6. On `requires_action` (client tools), no message is persisted yet. Submit outputs via [`POST /agents/:id/generate/:generation_id/tool-outputs`](/docs/api/agents/submit-agent-tool-outputs); the message is persisted on completion.

#### Concurrency

Generate calls hold a per-conversation advisory lock, so concurrent calls on one conversation are serialized and never race for a `position`.

#### Streaming

With `"stream": true` the response is `text/event-stream`. The message is persisted **only after** the stream completes; partial streams produce none. The final event carries `document_id`, `generation_id`, and `trace_id`.

### Tool Context

[`POST /api/v1/conversations/:id/generate`](/docs/api/conversations/generate-conversation-message) accepts `tool_context`, forwarded verbatim to the agent generation; see [Tool Context](../advanced/tool-context.md).

### Filtering by Actor

[`GET /conversations?actor_id=...`](/docs/api/conversations/list-conversations) lists conversations where the actor authored at least one message (an `EXISTS` join on `conversation_messages`, costlier than the default listing).

### Status

`open` or `closed`, default `open`; change via [`PATCH /conversations/:id`](/docs/api/conversations/update-conversation).

## Examples

### Create a conversation and add a message

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-conversation --project-id proj_ABC --name "Support Thread"
soat add-conversation-message \
  --conversation-id conv_01 \
  --message "Hello, I need help." \
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
  body: { message: 'Hello, I need help.', role: 'user' },
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
  -d '{"message": "Hello, I need help.", "role": "user"}'
```

</TabItem>
</Tabs>

### Generate the next message

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat generate-conversation-message --wait true \
  --conversation-id conv_01 \
  --agent-id agent_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data: reply } = await soat.conversations.generateConversationMessage({
  path: { conversation_id: 'conv_01' },
  query: { wait: true },
  body: { agent_id: 'agent_01' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/conversations/conv_01/generate?wait=true \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "agent_01"}'
```

</TabItem>
</Tabs>
