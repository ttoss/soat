---
description: "LLM completions with optional persistent configuration, supporting both stateless and per-chat modes in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chats

LLM completions with optional persistent configuration, supporting both stateless and per-chat modes.

## Overview

Chats provide two ways to call the completions API:

- **Stateless** (`POST /chat/completions`) — OpenAI-compatible; pass the full provider configuration on every request. No setup required.
- **Per-chat** (`POST /chats/{chat_id}/completions`) — create a Chat resource once to store the AI provider, default system message, and model; then pass only the `messages` array per request.

Both endpoints support SSE streaming via `stream: true`. To see a completion driven end to end through a provider-backed flow, follow [Connect Third-Party LLMs - Step 6 (Start a conversation)](/docs/tutorials/connect-third-party-llms#step-6--start-a-conversation).

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
| `ai_provider_id` | string   | Public ID of the AI provider used for completions                |
| `name`           | string   | Optional human-readable name                                     |
| `system_message` | string   | Optional default system prompt applied to all completions        |
| `model`          | string   | Optional model override (falls back to provider's `default_model`) |
| `created_at`     | string   | ISO 8601 creation timestamp                                      |
| `updated_at`     | string   | ISO 8601 last-updated timestamp                                  |

### Message

Each message in the `messages` array sent to the completions endpoint:

| Field         | Type                              | Description                                                               |
| ------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `role`        | `system` \| `user` \| `assistant` | Identifies the author of the message                                      |
| `content`     | string                            | Text body _(use this or `document_id`, not both)_                         |
| `document_id` | string                            | Public ID of a document — the server resolves its content before the call |

## Key Concepts

### System Message Override

When running `POST /chats/{chat_id}/completions`, if a message with `role: system` is included in the `messages` array it replaces the Chat's stored `system_message` for that call only — the Chat record is not modified.

### AI Provider Resolution

For per-chat completions the AI provider is taken from the Chat record. For stateless completions it is passed directly in the request body. See [AI Providers](./ai-providers.md) for the full list of supported providers and how secrets are resolved. For a worked example of creating a provider the Chat can reference, see [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider).

### Streaming

Set `stream: true` in the request body to receive an SSE stream. Each event contains a JSON object with a `choices[0].delta.content` chunk. The stream ends with `data: [DONE]`.

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
  --system-message "You are a helpful support assistant."
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
    system_message: 'You are a helpful support assistant.',
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
    "system_message": "You are a helpful support assistant."
  }'
```

</TabItem>
</Tabs>

### Run a per-chat completion

Once a Chat is stored, run completions against it by passing only the `messages` array — the AI provider, system message, and model come from the Chat record.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-chat-completion-for-chat \
  --chat-id chat_01 \
  --messages '[{"role":"user","content":"What can you help me with?"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.chats.createChatCompletionForChat({
  path: { chat_id: 'chat_01' },
  body: {
    messages: [{ role: 'user', content: 'What can you help me with?' }],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/chats/chat_01/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
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
  --system-message "You are a helpful assistant." \
  --messages '[{"role":"user","content":"Hello!"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.chats.createChatCompletion({
  body: {
    ai_provider_id: 'aip_abc123',
    system_message: 'You are a helpful assistant.',
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
    "system_message": "You are a helpful assistant.",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

</TabItem>
</Tabs>
