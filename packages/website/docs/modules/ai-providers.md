---
sidebar_position: 7
---

# AI Providers

The AI Providers module lets you register and manage LLM provider configurations for a project. Each provider record stores the model slug, optional base URL, optional configuration, and an optional link to a [Secret](./secrets.md) that supplies the API key.

## Overview

An AI provider is a named configuration that tells the system how to reach a specific LLM endpoint. A project can have multiple providers — for example, one for GPT-4o and another for Claude 3.5.

When a provider is linked to a secret the secret's encrypted value is retrieved and passed as the API key when calling the LLM. The key is never exposed through the API.

## Data Model

| Field          | Type             | Description                                               |
| -------------- | ---------------- | --------------------------------------------------------- |
| `id`           | string           | Public identifier (e.g. `aip_…`)                          |
| `projectId`    | string           | ID of the owning project                                  |
| `secretId`     | string \| null   | Public ID of the linked secret, or `null`                 |
| `name`         | string           | Human-readable label                                      |
| `provider`     | `AiProviderSlug` | Provider slug (see below)                                 |
| `defaultModel` | string           | Default model name sent to the provider API               |
| `baseUrl`      | string \| null   | Override base URL (optional, useful for self-hosted LLMs) |
| `config`       | object \| null   | Arbitrary provider-specific configuration object          |
| `createdAt`    | string           | ISO 8601 creation timestamp                               |
| `updatedAt`    | string           | ISO 8601 last-updated timestamp                           |

### Provider Slugs

Valid values for the `provider` field:

| Slug        | Description                |
| ----------- | -------------------------- |
| `openai`    | OpenAI                     |
| `anthropic` | Anthropic                  |
| `google`    | Google Gemini              |
| `xai`       | xAI (Grok)                 |
| `groq`      | Groq                       |
| `ollama`    | Ollama (local)             |
| `azure`     | Azure OpenAI               |
| `bedrock`   | Amazon Bedrock             |
| `gateway`   | Generic API gateway        |
| `custom`    | Custom / self-hosted model |

## Permissions

| Action          | Permission                     | REST Endpoint                               | MCP Tool             |
| --------------- | ------------------------------ | ------------------------------------------- | -------------------- |
| List providers  | `aiProviders:ListAiProviders`  | `GET /api/v1/ai-providers`                  | `list-ai-providers`  |
| Get a provider  | `aiProviders:GetAiProvider`    | `GET /api/v1/ai-providers/:aiProviderId`    | `get-ai-provider`    |
| Create provider | `aiProviders:CreateAiProvider` | `POST /api/v1/ai-providers`                 | `create-ai-provider` |
| Update provider | `aiProviders:UpdateAiProvider` | `PATCH /api/v1/ai-providers/:aiProviderId`  | `update-ai-provider` |
| Delete provider | `aiProviders:DeleteAiProvider` | `DELETE /api/v1/ai-providers/:aiProviderId` | `delete-ai-provider` |
