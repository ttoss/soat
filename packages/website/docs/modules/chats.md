---
description: "LLM completions with optional persistent configuration, supporting both stateless and per-chat modes in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chats

LLM completions with optional persistent configuration, supporting both stateless and per-chat modes.

## Overview

All completions go through [`POST /chat/completions`](/docs/api/chats/create-chat-completion), naming exactly one target:

- **Stateless** (`ai_provider_id`) — OpenAI-compatible; full provider configuration per request.
- **Per-chat** (`chat_id`) — a Chat stores the AI provider, default `instructions`, and model; pass `chat_id` and `messages` per request.

Naming neither, or both, is `400`. Both support SSE streaming via `stream: true`. Example: [Connect Third-Party LLMs - Step 6 (Start a conversation)](/docs/tutorials/connect-third-party-llms#step-6--start-a-conversation).

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

Each entry of `messages`:

| Field         | Type                   | Description                                                               |
| ------------- | ---------------------- | ------------------------------------------------------------------------- |
| `role`        | `user` \| `assistant`  | Identifies the author of the message. `system` is refused — see [System Instructions](#system-instructions) |
| `content`     | string                            | Text body _(use this or `document_id`, not both)_                         |
| `document_id` | string                            | Public ID of a document — the server resolves its content before the call |

## Key Concepts

### System Instructions

System content never travels as a message. It goes in `instructions` (same field name on a completion, a Chat, and an Agent); a `role: "system"` entry in `messages` is refused with `400 SYSTEM_MESSAGE_NOT_ALLOWED`.

The field is sent to the provider as the [AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)'s `instructions` argument; `allowSystemInMessages` defaults to `false` there, because a system message inside a caller-supplied array is a prompt-injection vector.

[Agents](./agents.md#instructions) and [Conversations](./conversations.md) apply the same rule with the same 400.

#### Per-chat override

A Chat's stored `instructions` apply to every completion on it; a call supplying its own `instructions` replaces them for that call without modifying the Chat. The two are never merged.

### AI Provider Resolution

Per-chat completions take the provider from the Chat; the pin must name a provider in the **chat's own project** (another project's answers `400 AI_PROVIDER_NOT_FOUND`, like a nonexistent id). A chat created **without** `ai_provider_id` resolves through the project's [`default_model_route_id`](./model-routes.md#project-default-route) for ordered failover; `model` cannot be combined with that, and omitting the provider is `400` when the project has no default.

Stateless completions **require** `ai_provider_id` in the body; there is no chat binding or default to inherit. The call is scoped to the provider's project; see [Authorization](#authorization).

Supported providers and secret resolution: [AI Providers](./ai-providers.md). Example: [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider).

### Authorization

Both targets require `chats:CreateChatCompletion` on the project the call belongs to:

| Target | Project the check runs against |
| --- | --- |
| `chat_id` | the chat's project |
| `ai_provider_id` | the AI provider's project |

A caller without it gets `403` before any provider call or SSE stream (a refused streaming request is a JSON `403`, never an error frame in a `200` stream). A nonexistent `ai_provider_id` is `404`, resolved before the permission check.

### Streaming

`stream: true` returns SSE; each event is a JSON object with a `choices[0].delta.content` chunk, ending with `data: [DONE]`.

### Upstream provider errors

When the provider rejects the completion (unavailable model, refused credential) or is unreachable, [`POST /api/v1/chat/completions`](/docs/api/chats/create-chat-completion) answers `502 AI_PROVIDER_ERROR` with the provider's status and message:

```json
{
  "error": {
    "code": "AI_PROVIDER_ERROR",
    "message": "Provider returned 404: model \"gemini-2.0-flash\" not found"
  }
}
```

Same mapping as [Agents](./agents.md) generation, so probing which models a provider can serve gives an interpretable answer instead of a bare `500`. A streaming request has already written `200`; the failure arrives as a terminal `data: {"error": "..."}` frame and the stream ends without `[DONE]`.

### Document-Backed Messages

A message may carry `document_id` instead of `content`; the server uses the document's `content`. jq-based selection of tool output (`output_path`) belongs to [Agents](./agents.md#tool-output-message-content).

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

Pass `chat_id` and `messages`; provider, `instructions`, and model come from the Chat. A Chat stores configuration, not history: no message is persisted, so send the full `messages` array each call.

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
