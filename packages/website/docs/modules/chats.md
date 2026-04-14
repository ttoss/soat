# Chats

The Chats module provides a stateless, OpenAI Chat Completions-compatible endpoint for text generation. It routes requests to any configured AI provider or falls back to a local Ollama instance.

## Overview

Unlike the Conversations module, Chats stores no data — each request is fully self-contained. The caller supplies the complete message history, and the server returns a single completion or streams delta chunks over Server-Sent Events (SSE).

## Key Concepts

### Messages

A message is an object with:

| Field     | Type                              | Description                          |
| --------- | --------------------------------- | ------------------------------------ |
| `role`    | `system` \| `user` \| `assistant` | Identifies the author of the message |
| `content` | `string`                          | Text body of the message             |

The `messages` array is passed directly to the AI provider. Include a `system` message at index 0 to set assistant behaviour.

### AI Provider Resolution

When `aiProviderId` is supplied the server:

1. Looks up the AI provider record and decrypts its secret.
2. Instantiates the matching Vercel AI SDK provider (see table below).
3. Uses the `model` field if provided, otherwise falls back to the provider's `defaultModel`.

When `aiProviderId` is omitted the server falls back to:

- Model: `CHAT_MODEL` environment variable, or `llama3.2`
- Provider: Ollama at `OLLAMA_BASE_URL`

### Supported Providers

| Provider slug | AI SDK package           | Secret type                               |
| ------------- | ------------------------ | ----------------------------------------- |
| `openai`      | `@ai-sdk/openai`         | API key                                   |
| `anthropic`   | `@ai-sdk/anthropic`      | API key                                   |
| `google`      | `@ai-sdk/google`         | API key                                   |
| `xai`         | `@ai-sdk/xai`            | API key                                   |
| `groq`        | `@ai-sdk/groq`           | API key                                   |
| `azure`       | `@ai-sdk/azure`          | API key + `resourceName` in config        |
| `bedrock`     | `@ai-sdk/amazon-bedrock` | AWS credentials JSON + `region` in config |
| `ollama`      | `ollama-ai-provider`     | None — local URL via `baseUrl`            |
| `gateway`     | `@ai-sdk/openai`         | AI Gateway API key + `baseUrl`            |
| `custom`      | `@ai-sdk/openai`         | API key + `baseUrl`                       |

### Streaming

Set `stream: true` in the request body to receive an SSE stream. Each event contains a JSON object with a `choices[0].delta.content` chunk. The stream ends with `data: [DONE]`.

## Permissions

| Operation         | Requirement        |
| ----------------- | ------------------ |
| Create completion | Authenticated user |

Authentication uses a standard JWT bearer token. No additional project-level permission is required beyond having a valid session.
