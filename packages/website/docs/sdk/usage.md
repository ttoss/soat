---
sidebar_position: 2
---

# Usage Examples

Examples for common operations across all SOAT modules. All examples assume a `SoatClient` instance — see [Introduction](./introduction.md) for setup.

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({
  baseUrl: 'https://your-soat-server.com',
  token: 'sk_...',
});
```

## Users

Bootstrap the first admin user, then create additional users. → [Full Users API](/docs/api/users/list-users)

```ts
const { error: bootstrapError } = await soat.users.bootstrapUser({
  body: { username: 'admin', password: 'supersecret' },
});

if (bootstrapError) throw new Error(JSON.stringify(bootstrapError));

const { data: user, error } = await soat.users.createUser({
  body: { username: 'alice', password: 'alicepass' },
});

if (error) throw new Error(JSON.stringify(error));
```

## Files

Upload and download files. → [Full Files API](/docs/api/files/list-files)

```ts
const form = new FormData();
form.append('file', fileBlob, 'report.pdf');

const { data: file, error: uploadError } = await soat.files.uploadFile({
  body: form,
});

if (uploadError) throw new Error(JSON.stringify(uploadError));

const { data: content, error: downloadError } = await soat.files.downloadFile({
  path: { file_id: file.id },
});

if (downloadError) throw new Error(JSON.stringify(downloadError));
```

## Documents

Create and semantically search text documents. → [Full Documents API](/docs/api/documents/list-documents)

```ts
const { error: createError } = await soat.documents.createDocument({
  body: { title: 'Q1 Report', content: 'Revenue grew 20%...' },
});

if (createError) throw new Error(JSON.stringify(createError));

const { data: results, error: searchError } =
  await soat.documents.searchDocuments({
    body: { query: 'revenue growth', limit: 5 },
  });

if (searchError) throw new Error(JSON.stringify(searchError));
```

## Conversations

Multi-turn conversations with AI-generated replies. → [Full Conversations API](/docs/api/conversations/list-conversations)

```ts
const { data: conv, error: convError } =
  await soat.conversations.createConversation({
    body: { title: 'Support thread' },
  });

if (convError) throw new Error(JSON.stringify(convError));

const { error: msgError } = await soat.conversations.addConversationMessage({
  path: { conversation_id: conv.id },
  body: { role: 'user', content: 'How do I reset my password?' },
});

if (msgError) throw new Error(JSON.stringify(msgError));

const { data: reply, error: genError } =
  await soat.conversations.generateConversationMessage({
    path: { conversation_id: conv.id },
    body: { actor_id: 'act_...' },
  });

if (genError) throw new Error(JSON.stringify(genError));

if (reply.status === 'completed') {
  console.log(reply.content); // AI-generated text
}
```

## Chats

Stateless one-shot completions or stateful chat sessions. → [Full Chats API](/docs/api/chats/list-chats)

```ts
// Stateless
const { data, error: completionError } = await soat.chats.createChatCompletion({
  body: { messages: [{ role: 'user', content: 'Summarize this.' }] },
});

if (completionError) throw new Error(JSON.stringify(completionError));

// Stateful
const { data: chat, error: chatError } = await soat.chats.createChat({
  body: { system_message: 'You are a helpful assistant.' },
});

if (chatError) throw new Error(JSON.stringify(chatError));

const { data: reply, error: replyError } =
  await soat.chats.createChatCompletionForChat({
    path: { chat_id: chat.id },
    body: { content: 'Hello!' },
  });

if (replyError) throw new Error(JSON.stringify(replyError));
```

## Agents

Autonomous AI workers with tool use and multi-step execution. → [Full Agents API](/docs/modules/agents)

```ts
const { data: agent, error: agentError } = await soat.agents.createAgent({
  body: { name: 'my-agent', instructions: 'You are a helpful assistant.' },
});

if (agentError) throw new Error(JSON.stringify(agentError));

const { data: gen, error: genError } = await soat.agents.createAgentGeneration({
  path: { agent_id: agent.id },
  body: {
    messages: [{ role: 'user', content: 'What files are available?' }],
  },
});

if (genError) throw new Error(JSON.stringify(genError));

// Handle client-side tool calls
if (gen.status === 'requires_action') {
  const toolCall = gen.required_action.tool_calls[0];

  const { error: toolError } = await soat.agents.submitAgentToolOutputs({
    path: { agent_id: agent.id, generation_id: gen.generation_id },
    body: {
      tool_outputs: [{ tool_call_id: toolCall.id, output: '["file-1"]' }],
    },
  });

  if (toolError) throw new Error(JSON.stringify(toolError));
}
```

## Actors

Participants (human or AI) that can be attached to conversations. → [Full Actors API](/docs/api/actors/list-actors)

```ts
const { data: actor, error } = await soat.actors.createActor({
  body: { name: 'Support Bot', type: 'ai' },
});

if (error) throw new Error(JSON.stringify(error));
```
