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

Every call returns `{ data, error, response }`. **Always destructure `{ data, error }` and check for errors first before using `data`:**

```ts
const { data, error } = await soat.GET('/api/v1/files');

if (error) {
  // Handle the error: throw, return, or log
  throw new Error(error.message);
}

// Now you can safely use data
console.log(data); // fully typed
```

**Important:** Never use `data` without checking `error` first. Use early returns or throws to handle errors appropriately.

For the full list of available paths, parameters, and response schemas for each module, see the **[API Reference](/docs/api/users/list-users)**.

---

## Examples

### Users

Bootstrap the first admin user and create additional users. → [Full Users API](/docs/api/users/list-users)

```ts
const { error: bootstrapError } = await soat.POST('/api/v1/users/bootstrap', {
  body: { username: 'admin', password: 'supersecret' },
});

if (bootstrapError) {
  throw new Error(bootstrapError.message);
}

const { data: user, error: userError } = await soat.POST('/api/v1/users', {
  body: { username: 'alice', password: 'alicepass' },
});

if (userError) {
  throw new Error(userError.message);
}
```

### Files

Upload and download files. → [Full Files API](/docs/api/files/list-files)

```ts
const form = new FormData();
form.append('file', fileBlob, 'report.pdf');
const { data: file, error: uploadError } = await soat.POST(
  '/api/v1/files/upload',
  {
    body: form,
  }
);

if (uploadError) {
  throw new Error(uploadError.message);
}

const { data: content, error: downloadError } = await soat.GET(
  '/api/v1/files/{id}/download',
  {
    params: { path: { id: file.id } },
  }
);

if (downloadError) {
  throw new Error(downloadError.message);
}
```

### Documents

Create and semantically search text documents. → [Full Documents API](/docs/api/documents/list-documents)

```ts
const { error: createError } = await soat.POST('/api/v1/documents', {
  body: { title: 'Q1 Report', content: 'Revenue grew 20%...' },
});

if (createError) {
  throw new Error(createError.message);
}

const { data: results, error: searchError } = await soat.POST(
  '/api/v1/documents/search',
  {
    body: { query: 'revenue growth', limit: 5 },
  }
);

if (searchError) {
  throw new Error(searchError.message);
}
```

### Conversations

Multi-turn conversations with AI-generated replies. → [Full Conversations API](/docs/api/conversations/list-conversations)

```ts
const { data: conv, error: convError } = await soat.POST(
  '/api/v1/conversations',
  {
    body: { title: 'Support thread' },
  }
);

if (convError) {
  throw new Error(convError.message);
}

const { error: msgError } = await soat.POST(
  '/api/v1/conversations/{id}/messages',
  {
    params: { path: { id: conv.id } },
    body: { role: 'user', content: 'How do I reset my password?' },
  }
);

if (msgError) {
  throw new Error(msgError.message);
}

const { data: reply, error: genError } = await soat.POST(
  '/api/v1/conversations/{id}/generate',
  {
    params: { path: { id: conv.id } },
    body: { actor_id: 'act_...' },
  }
);

if (genError) {
  throw new Error(genError.message);
}

// reply.content is the canonical field for the AI-generated text
const responseText = reply?.content;
```

### Chats

Stateless one-shot completions or stateful chat sessions. → [Full Chats API](/docs/api/chats/list-chats)

```ts
// Stateless
const { data, error: completionError } = await soat.POST(
  '/api/v1/chats/completions',
  {
    body: { messages: [{ role: 'user', content: 'Summarize this.' }] },
  }
);

if (completionError) {
  throw new Error(completionError.message);
}

// Stateful
const { data: chat, error: chatError } = await soat.POST('/api/v1/chats', {
  body: { system_message: 'You are a helpful assistant.' },
});

if (chatError) {
  throw new Error(chatError.message);
}

const { data: reply, error: replyError } = await soat.POST(
  '/api/v1/chats/{chatId}/completions',
  {
    params: { path: { chatId: chat.id } },
    body: { content: 'Hello!' },
  }
);

if (replyError) {
  throw new Error(replyError.message);
}
```

### Agents

Autonomous AI workers with tool use and multi-step execution. → [Full Agents API](/docs/modules/agents)

```ts
const { data: agent, error: agentError } = await soat.POST('/api/v1/agents', {
  body: { name: 'my-agent', instructions: 'You are a helpful assistant.' },
});

if (agentError) {
  throw new Error(agentError.message);
}

const { data: gen, error: genError } = await soat.POST(
  '/api/v1/agents/{agentId}/generate',
  {
    params: { path: { agentId: agent.id } },
    body: {
      messages: [{ role: 'user', content: 'What files are available?' }],
    },
  }
);

if (genError) {
  throw new Error(genError.message);
}

// Handle client-side tool calls
if (gen.status === 'requires_action') {
  const toolCall = gen.required_action.tool_calls[0];
  const { error: toolError } = await soat.POST(
    '/api/v1/agents/{agentId}/generate/{generationId}/tool-outputs',
    {
      params: { path: { agentId: agent.id, generationId: gen.id } },
      body: {
        tool_outputs: [{ tool_call_id: toolCall.id, output: '["file-1"]' }],
      },
    }
  );

  if (toolError) {
    throw new Error(toolError.message);
  }
}
```

### Actors

Participants (human or AI) that can be attached to conversations. → [Full Actors API](/docs/api/actors/list-actors)

```ts
const { data: actor, error: actorError } = await soat.POST('/api/v1/actors', {
  body: { name: 'Support Bot', type: 'ai' },
});

if (actorError) {
  throw new Error(actorError.message);
}
```
