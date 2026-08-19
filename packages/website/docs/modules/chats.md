---
description: "LLM completions with optional persistent configuration, supporting both stateless and per-chat modes in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chats

LLM completions with optional persistent configuration, supporting both stateless and per-chat modes.

## Overview

All completions run through a single endpoint, [`POST /chat/completions`](/docs/api/chats/create-chat-completion), which names exactly one target:

- **Stateless** (`ai_provider_id`) — OpenAI-compatible; pass the full provider configuration on every request. No setup required.
- **Per-chat** (`chat_id`) — create a Chat resource once to store the AI provider, default `instructions`, and model; then pass only `chat_id` and the `messages` array per request.

The two are mutually exclusive, and a request naming neither — or both — is rejected with `400`.

Both targets support SSE streaming via `stream: true`. To see a completion driven end to end through a provider-backed flow, follow [Connect Third-Party LLMs - Step 6 (Start a conversation)](/docs/tutorials/connect-third-party-llms#step-6--start-a-conversation).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider)
- [Connect Third-Party LLMs - Step 6 (Start a conversation)](/docs/tutorials/connect-third-party-llms#step-6--start-a-conversation)

## Data Model

### Chat

| Field            | Type     | Description                                                      |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `id`             | string   | Public ID prefixed with `chat_`                                  |
| `project_id`     | string   | Public ID of the owning project                                  |
| `ai_provider_id` | string \| null | Public ID of the pinned AI provider, or `null` when the chat pins none and inherits its project's [`default_model_route_id`](./model-routes.md#project-default-route) |
| `name`           | string   | Optional human-readable name                                     |
| `instructions` | string   | Optional default system prompt applied to all completions — the same name an [Agent](./agents.md#instructions) uses |
| `model`          | string   | Optional model override (falls back to provider's `default_model`) |
| `created_at`     | string   | ISO 8601 creation timestamp                                      |
| `updated_at`     | string   | ISO 8601 last-updated timestamp                                  |

### Message

Each message in the `messages` array sent to the completions endpoint:

| Field         | Type                   | Description                                                               |
| ------------- | ---------------------- | ------------------------------------------------------------------------- |
| `role`        | `user` \| `assistant`  | Identifies the author of the message. `system` is refused — see [System Instructions](#system-instructions) |
| `content`     | string                            | Text body _(use this or `document_id`, not both)_                         |
| `document_id` | string                            | Public ID of a document — the server resolves its content before the call |

## Key Concepts

### System Instructions

System content never travels as a message — one rule, on every SOAT surface. On a completion it goes in the `instructions` request field — the same name everywhere: a completion request, a Chat, an Agent — and a `role: "system"` entry in `messages` is refused with `400 SYSTEM_MESSAGE_NOT_ALLOWED`.

The server sends the field to the provider as its `instructions` argument, which is the only place the underlying [AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) accepts it — `allowSystemInMessages` defaults to `false` there and throws, because a system message inside a caller-supplied array is a prompt-injection vector. SOAT's wire contract is the same contract.

The same rule everywhere else: an agent's system prompt is its `instructions` field ([Agents](./agents.md#instructions)), and a conversation's stored history carries only `user` and `assistant` turns ([Conversations](./conversations.md)) — all three refuse a system entry with the same 400.

#### Per-chat override

A Chat stores `instructions` applied to every completion on it. A single call replaces them by supplying its own `instructions`. The Chat record is not modified.

The stored prompt applies only when the request carries none. The two are never merged: combining them would produce a prompt neither the chat nor the caller wrote.

### AI Provider Resolution

For per-chat completions the AI provider is taken from the Chat record. A chat created **without** `ai_provider_id` pins none and resolves through its project's [`default_model_route_id`](./model-routes.md#project-default-route) instead, which gives its completions ordered provider failover; `model` cannot be combined with that (each route target names its own), and omitting the provider returns `400` when the project has no default.

For a stateless completion `ai_provider_id` is passed directly in the request body and is **required** — that call belongs to no chat, so there is no chat binding and no default to inherit. It is still scoped to a project: the provider's own — see [Authorization](#authorization).

See [AI Providers](./ai-providers.md) for the full list of supported providers and how secrets are resolved. For a worked example of creating a provider the Chat can reference, see [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider).

### Authorization

Both targets are gated on the same action, `chats:CreateChatCompletion`, each checked against the project the call belongs to:

| Target | Project the check runs against |
| --- | --- |
| `chat_id` | the chat's project |
| `ai_provider_id` | the AI provider's project |

A caller without the action on that project gets `403`, before any provider call and before an SSE stream is opened — a refused streaming request is a JSON `403`, never an error frame inside a `200` stream. An `ai_provider_id` that does not exist is still `404`, which is resolved before the permission check.

### Streaming

Set `stream: true` in the request body to receive an SSE stream. Each event contains a JSON object with a `choices[0].delta.content` chunk. The stream ends with `data: [DONE]`.

### Upstream provider errors

When the provider rejects the completion — an unavailable model, a refused credential — or cannot be reached, [`POST /api/v1/chat/completions`](/docs/api/chats/create-chat-completion) answers `502 AI_PROVIDER_ERROR` with the provider's own status and message in the error message:

```json
{
  "error": {
    "code": "AI_PROVIDER_ERROR",
    "message": "Provider returned 404: model \"gemini-2.0-flash\" not found"
  }
}
```

This is the same mapping [Agents](./agents.md) generation applies, so probing which models a provider can actually serve gives an interpretable answer instead of a bare `500`.

A streaming request cannot report this as a status code — its `200` and headers are written before the provider is called. The failure arrives as a terminal `data: {"error": "..."}` frame carrying the same message, and the stream then ends without a `[DONE]`.

### Document-Backed Messages

A message may carry a `document_id` instead of inline `content`. The server fetches that document and uses its `content` field as the message body. jq-based selection of tool output (the `output_path` behavior) is handled by [Agents](./agents.md#tool-output-message-content).

## Examples

### Create a chat

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-chat \
  --project-id proj_ABC \
  --ai-provider-id aip_abc123 \
  --name "Support Assistant" \
  --instructions "You are a helpful support assistant."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.chats.createChat({
  body: {
    project_id: 'proj_ABC',
    ai_provider_id: 'aip_abc123',
    name: 'Support Assistant',
    instructions: 'You are a helpful support assistant.',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/chats \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "ai_provider_id": "aip_abc123",
    "name": "Support Assistant",
    "instructions": "You are a helpful support assistant."
  }'
```

</TabItem>
</Tabs>

### Run a per-chat completion

Once a Chat is stored, run completions against it by passing `chat_id` and the `messages` array — the AI provider, `instructions`, and model come from the Chat record.

A Chat stores configuration, not conversation history: no message sent to or returned from a completion is persisted, so send the full `messages` array on every call.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-chat-completion \
  --chat_id chat_01 \
  --messages '[{"role":"user","content":"What can you help me with?"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.chats.createChatCompletion({
  body: {
    chat_id: 'chat_01',
    messages: [{ role: 'user', content: 'What can you help me with?' }],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": "chat_01",
    "messages": [{ "role": "user", "content": "What can you help me with?" }]
  }'
```

</TabItem>
</Tabs>

### Run a stateless completion

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-chat-completion \
  --ai-provider-id aip_abc123 \
  --instructions "You are a helpful assistant." \
  --messages '[{"role":"user","content":"Hello!"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.chats.createChatCompletion({
  body: {
    ai_provider_id: 'aip_abc123',
    instructions: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hello!' }],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "ai_provider_id": "aip_abc123",
    "instructions": "You are a helpful assistant.",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

</TabItem>
</Tabs>
