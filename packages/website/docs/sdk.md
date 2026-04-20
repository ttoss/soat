---
sidebar_label: SDK
---

# SOAT SDK

The `@soat/sdk` package is a typed TypeScript client for the SOAT REST API. It is generated directly from the OpenAPI specs, so every endpoint, parameter, and response body is fully typed.

## Installation

```bash
npm install @soat/sdk
# or
pnpm add @soat/sdk
```

## Setup

```ts
import { createSoatClient } from '@soat/sdk';

const soat = createSoatClient({
  baseUrl: 'https://your-soat-server.com',
  token: 'your-bearer-token',
});
```

| Option    | Type     | Required | Description                          |
| --------- | -------- | -------- | ------------------------------------ |
| `baseUrl` | `string` | Yes      | Base URL of the SOAT server          |
| `token`   | `string` | No       | Bearer token for authenticated calls |

---

## Usage Pattern

The client exposes typed methods for every HTTP verb: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. The first argument is the API path (autocompleted from the spec) and the second is an options object with `params` (path/query) and `body`.

```ts
// GET with path params
const { data: file } = await soat.GET('/api/v1/files/{id}', {
  params: { path: { id: 'file-123' } },
});

// POST with body
const { data: user } = await soat.POST('/api/v1/users', {
  body: { username: 'alice', password: 'alicepass' },
});

// DELETE
await soat.DELETE('/api/v1/files/{id}', {
  params: { path: { id: 'file-123' } },
});
```

Every call returns `{ data, error, response }`. Check `error` before using `data`:

```ts
const { data, error } = await soat.GET('/api/v1/files');

if (error) {
  console.error('Request failed:', error.message);
} else {
  console.log(data); // fully typed
}
```

For the full list of available paths, parameters, and response schemas for each module, see the **[API Reference](/docs/api/users/list-users)**.

---

## Examples

### Users

Bootstrap the first admin user and create additional users. → [Full Users API](/docs/api/users/list-users)

```ts
await soat.POST('/api/v1/users/bootstrap', {
  body: { username: 'admin', password: 'supersecret' },
});

const { data: user } = await soat.POST('/api/v1/users', {
  body: { username: 'alice', password: 'alicepass' },
});
```

### Files

Upload and download files. → [Full Files API](/docs/api/files/list-files)

```ts
const form = new FormData();
form.append('file', fileBlob, 'report.pdf');
const { data: file } = await soat.POST('/api/v1/files/upload', {
  body: form,
});

const { data: content } = await soat.GET('/api/v1/files/{id}/download', {
  params: { path: { id: file.id } },
});
```

### Documents

Create and semantically search text documents. → [Full Documents API](/docs/api/documents/list-documents)

```ts
await soat.POST('/api/v1/documents', {
  body: { title: 'Q1 Report', content: 'Revenue grew 20%...' },
});

const { data: results } = await soat.POST('/api/v1/documents/search', {
  body: { query: 'revenue growth', limit: 5 },
});
```

### Conversations

Multi-turn conversations with AI-generated replies. → [Full Conversations API](/docs/api/conversations/list-conversations)

```ts
const { data: conv } = await soat.POST('/api/v1/conversations', {
  body: { title: 'Support thread' },
});

await soat.POST('/api/v1/conversations/{id}/messages', {
  params: { path: { id: conv.id } },
  body: { role: 'user', content: 'How do I reset my password?' },
});

const { data: reply } = await soat.POST('/api/v1/conversations/{id}/generate', {
  params: { path: { id: conv.id } },
  body: {},
});
```

### Chats

Stateless one-shot completions or stateful chat sessions. → [Full Chats API](/docs/api/chats/list-chats)

```ts
// Stateless
const { data } = await soat.POST('/api/v1/chats/completions', {
  body: { messages: [{ role: 'user', content: 'Summarize this.' }] },
});

// Stateful
const { data: chat } = await soat.POST('/api/v1/chats', {
  body: { systemMessage: 'You are a helpful assistant.' },
});
const { data: reply } = await soat.POST('/api/v1/chats/{chatId}/completions', {
  params: { path: { chatId: chat.id } },
  body: { content: 'Hello!' },
});
```

### Agents

Autonomous AI workers with tool use and multi-step execution. → [Full Agents API](/docs/modules/agents)

```ts
const { data: agent } = await soat.POST('/api/v1/agents', {
  body: { name: 'my-agent', instructions: 'You are a helpful assistant.' },
});

const { data: gen } = await soat.POST('/api/v1/agents/{agentId}/generate', {
  params: { path: { agentId: agent.id } },
  body: { messages: [{ role: 'user', content: 'What files are available?' }] },
});

// Handle client-side tool calls
if (gen.status === 'requires_action') {
  const toolCall = gen.requiredAction.toolCalls[0];
  await soat.POST(
    '/api/v1/agents/{agentId}/generate/{generationId}/tool-outputs',
    {
      params: { path: { agentId: agent.id, generationId: gen.id } },
      body: {
        toolOutputs: [{ toolCallId: toolCall.id, output: '["file-1"]' }],
      },
    }
  );
}
```

### Actors

Participants (human or AI) that can be attached to conversations. → [Full Actors API](/docs/api/actors/list-actors)

```ts
const { data: actor } = await soat.POST('/api/v1/actors', {
  body: { name: 'Support Bot', type: 'ai' },
});
```
