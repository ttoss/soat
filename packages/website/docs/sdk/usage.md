---
sidebar_position: 2
---

# Usage Examples

Examples for common operations across all SOAT modules. All examples assume a configured `client` instance — see [Introduction](./introduction.md) for setup.

## Users

Bootstrap the first admin user, then create additional users. → [Full Users API](/docs/api/users/list-users)

```ts
import { Users } from '@soat/sdk';

const { error: bootstrapError } = await Users.bootstrapUser({
  client,
  body: { username: 'admin', password: 'supersecret' },
});

if (bootstrapError) throw new Error(JSON.stringify(bootstrapError));

const { data: user, error } = await Users.createUser({
  client,
  body: { username: 'alice', password: 'alicepass' },
});

if (error) throw new Error(JSON.stringify(error));
```

## Files

Upload and download files. → [Full Files API](/docs/api/files/list-files)

```ts
import { Files } from '@soat/sdk';

const form = new FormData();
form.append('file', fileBlob, 'report.pdf');

const { data: file, error: uploadError } = await Files.uploadFile({
  client,
  body: form,
});

if (uploadError) throw new Error(JSON.stringify(uploadError));

const { data: content, error: downloadError } = await Files.downloadFile({
  client,
  path: { id: file.id },
});

if (downloadError) throw new Error(JSON.stringify(downloadError));
```

## Documents

Create and semantically search text documents. → [Full Documents API](/docs/api/documents/list-documents)

```ts
import { Documents } from '@soat/sdk';

const { error: createError } = await Documents.createDocument({
  client,
  body: { title: 'Q1 Report', content: 'Revenue grew 20%...' },
});

if (createError) throw new Error(JSON.stringify(createError));

const { data: results, error: searchError } = await Documents.searchDocuments({
  client,
  body: { query: 'revenue growth', limit: 5 },
});

if (searchError) throw new Error(JSON.stringify(searchError));
```

## Conversations

Multi-turn conversations with AI-generated replies. → [Full Conversations API](/docs/api/conversations/list-conversations)

```ts
import { Conversations } from '@soat/sdk';

const { data: conv, error: convError } = await Conversations.createConversation(
  {
    client,
    body: { title: 'Support thread' },
  }
);

if (convError) throw new Error(JSON.stringify(convError));

const { error: msgError } = await Conversations.addConversationMessage({
  client,
  path: { id: conv.id },
  body: { role: 'user', content: 'How do I reset my password?' },
});

if (msgError) throw new Error(JSON.stringify(msgError));

const { data: reply, error: genError } =
  await Conversations.generateConversationMessage({
    client,
    path: { id: conv.id },
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
import { Chats } from '@soat/sdk';

// Stateless
const { data, error: completionError } = await Chats.createChatCompletion({
  client,
  body: { messages: [{ role: 'user', content: 'Summarize this.' }] },
});

if (completionError) throw new Error(JSON.stringify(completionError));

// Stateful
const { data: chat, error: chatError } = await Chats.createChat({
  client,
  body: { system_message: 'You are a helpful assistant.' },
});

if (chatError) throw new Error(JSON.stringify(chatError));

const { data: reply, error: replyError } =
  await Chats.createChatCompletionForChat({
    client,
    path: { chatId: chat.id },
    body: { content: 'Hello!' },
  });

if (replyError) throw new Error(JSON.stringify(replyError));
```

## Agents

Autonomous AI workers with tool use and multi-step execution. → [Full Agents API](/docs/modules/agents)

```ts
import { Agents } from '@soat/sdk';

const { data: agent, error: agentError } = await Agents.createAgent({
  client,
  body: { name: 'my-agent', instructions: 'You are a helpful assistant.' },
});

if (agentError) throw new Error(JSON.stringify(agentError));

const { data: gen, error: genError } = await Agents.createAgentGeneration({
  client,
  path: { agentId: agent.id },
  body: {
    messages: [{ role: 'user', content: 'What files are available?' }],
  },
});

if (genError) throw new Error(JSON.stringify(genError));

// Handle client-side tool calls
if (gen.status === 'requires_action') {
  const toolCall = gen.required_action.tool_calls[0];

  const { error: toolError } = await Agents.submitAgentToolOutputs({
    client,
    path: { agentId: agent.id, generationId: gen.generation_id },
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
import { Actors } from '@soat/sdk';

const { data: actor, error } = await Actors.createActor({
  client,
  body: { name: 'Support Bot', type: 'ai' },
});

if (error) throw new Error(JSON.stringify(error));
```
