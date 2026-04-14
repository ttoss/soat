# Chats

The Chats module provides both a stateless completions endpoint and a stateful Chat resource. A Chat stores the AI provider, an optional default system message, and an optional model override so callers only need to pass the conversation history per request.

## Overview

There are two ways to call the completions API:

### Stateless — `POST /chats/completions`

No setup required. Every request must include the full provider configuration — `aiProviderId`, optional `systemMessage`, and optional `model`. Use this for one-off calls or when the provider configuration changes per request.

```json
POST /api/v1/chats/completions
{
  "aiProviderId": "aip_abc123",
  "systemMessage": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

### Per-chat — `POST /chats/{chatId}/completions`

Requires creating a Chat resource first (`POST /chats`). The Chat stores the AI provider, default system message, and model — callers only need to pass the `messages` array per request. Use this when the same configuration is reused across many calls.

**Step 1 — create the chat once:**

```json
POST /api/v1/chats
{
  "projectId": "prj_xyz",
  "aiProviderId": "aip_abc123",
  "systemMessage": "You are a helpful assistant.",
  "name": "My Assistant"
}
```

**Step 2 — run completions using the returned `id`:**

```json
POST /api/v1/chats/cht_def456/completions
{
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

Both endpoints support SSE streaming via `stream: true`.

## Key Concepts

### Chat Resource

A Chat is a persistent resource belonging to a project. It stores:

| Field           | Type     | Description                                                     |
| --------------- | -------- | --------------------------------------------------------------- |
| `id`            | `string` | Public ID prefixed with `cht_`                                  |
| `projectId`     | `string` | Public ID of the owning project                                 |
| `aiProviderId`  | `string` | Public ID of the AI provider used for completions               |
| `name`          | `string` | Optional human-readable name                                    |
| `systemMessage` | `string` | Optional default system prompt applied to all completions       |
| `model`         | `string` | Optional model override (falls back to provider's defaultModel) |
| `createdAt`     | `string` | ISO 8601 creation timestamp                                     |
| `updatedAt`     | `string` | ISO 8601 last-updated timestamp                                 |

### Messages

Each message in the `messages` array can specify content in two ways:

| Field        | Type                              | Description                                                               |
| ------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `role`       | `system` \| `user` \| `assistant` | Identifies the author of the message                                      |
| `content`    | `string`                          | Text body _(use this or `documentId`, not both)_                          |
| `documentId` | `string`                          | Public ID of a document — the server resolves its content before the call |

When `documentId` is supplied the server fetches the document and uses its `content` field as the message body.

### System Message Override

When running `POST /chats/{chatId}/completions`, if a message with `role: system` is included in the `messages` array it replaces the Chat's stored `systemMessage` for that call only — the Chat record is not modified.

### AI Provider Resolution

See the [AI Providers](./aiProviders.md) module for the full list of supported providers and how secrets are resolved. For per-chat completions the AI provider is taken from the Chat record. For stateless completions it is passed directly in the request body.

### Streaming

Set `stream: true` in the request body to receive an SSE stream. Each event contains a JSON object with a `choices[0].delta.content` chunk. The stream ends with `data: [DONE]`.

## Permissions

| Action                   | Permission                     | REST Endpoint                      | MCP Tool                          |
| ------------------------ | ------------------------------ | ---------------------------------- | --------------------------------- |
| Create a chat            | `chats:CreateChat`             | `POST /chats`                      | `create-chat`                     |
| List chats               | `chats:ListChats`              | `GET /chats`                       | `list-chats`                      |
| Get a chat               | `chats:GetChat`                | `GET /chats/{chatId}`              | `get-chat`                        |
| Delete a chat            | `chats:DeleteChat`             | `DELETE /chats/{chatId}`           | `delete-chat`                     |
| Run per-chat completion  | `chats:CreateChatCompletion`   | `POST /chats/{chatId}/completions` | `create-chat-completion-for-chat` |
| Run stateless completion | Authenticated user (no policy) | `POST /chats/completions`          | `create-chat-completion`          |
