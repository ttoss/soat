import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# AI Providers

The AI Providers module lets you register and manage LLM provider configurations for a project. Each provider record stores the model slug, optional base URL, optional configuration, and an optional link to a [Secret](./secrets.md) that supplies the API key.

## Overview

An AI provider is a named configuration that tells the system how to reach a specific LLM endpoint. A project can have multiple providers — for example, one for GPT-4o and another for Claude 3.5.

When a provider is linked to a secret the secret's encrypted value is retrieved and passed as the API key when calling the LLM. The key is never exposed through the API. See it end to end in [Connect Third-Party LLMs - Step 4 (Create provider records)](/docs/tutorials/connect-third-party-llms#step-4--create-provider-records).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider)
- [Connect Third-Party LLMs - Step 4 (Create provider records)](/docs/tutorials/connect-third-party-llms#step-4--create-provider-records)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 3 (Create an AI provider)](/docs/tutorials/multi-agent-orchestration#step-3--create-an-ai-provider)

## Data Model

| Field           | Type             | Description                                               |
| --------------- | ---------------- | --------------------------------------------------------- |
| `id`            | string           | Public identifier (e.g. `aip_…`)                          |
| `project_id`    | string           | ID of the owning project                                  |
| `secret_id`     | string \| null   | Public ID of the linked secret, or `null`                 |
| `name`          | string           | Human-readable label                                      |
| `provider`      | `AiProviderSlug` | Provider slug (see below)                                 |
| `default_model` | string           | Default model name sent to the provider API               |
| `base_url`      | string \| null   | Override base URL (optional, useful for self-hosted LLMs) |
| `config`        | object \| null   | Arbitrary provider-specific configuration object          |
| `created_at`    | string           | ISO 8601 creation timestamp                               |
| `updated_at`    | string           | ISO 8601 last-updated timestamp                           |

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

A local `ollama` provider needs no linked secret — it uses the server's `OLLAMA_BASE_URL` instead. See it end to end in [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider).

## Key Concepts

### Bedrock authentication

The `bedrock` provider supports two authentication modes, determined by the shape of the linked secret's JSON value:

**IAM credentials** — pass `accessKeyId`, `secretAccessKey`, and optionally `sessionToken`. The client signs requests with AWS SigV4.

```json
{
  "accessKeyId": "<aws-access-key-id>",
  "secretAccessKey": "<aws-secret-access-key>",
  "sessionToken": "<optional-session-token>"
}
```

**Bedrock API key** — pass `apiKey` only (format `ABSK…`). The client uses Bearer token authentication via `AWS_BEARER_TOKEN_BEDROCK`. This is the [new authentication mechanism introduced for Amazon Bedrock in 2025](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).

```json
{ "apiKey": "ABSK..." }
```

> **Important:** Store the secret value as a **JSON object** (shown above) — this is the canonical form and the only one that supports IAM credentials. As a convenience, a bare `ABSK…` string (with no JSON wrapper) is also accepted: the server tries to parse the value as JSON first, and if that fails but the value starts with `ABSK` it is treated as `{ "apiKey": "<value>" }`. IAM credentials (`accessKeyId` / `secretAccessKey`) must always use the JSON object form.

If neither field is present the default AWS credential chain (environment variables, instance profile, etc.) is used. The `region` field in the provider's `config` object defaults to `us-east-1`.

You can also pass the API key directly in the provider's `config` object as `api_key` (without linking a secret). This is useful for quick testing but the secret-linked approach is recommended for production.

```json
{ "api_key": "ABSK..." }
```

## Examples

### Create an AI provider

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ai-provider \
  --project-id proj_ABC \
  --name "OpenAI GPT-4o" \
  --provider openai \
  --default-model gpt-4o \
  --secret-id sec_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.aiProviders.createAiProvider({
  body: {
    project_id: 'proj_ABC',
    name: 'OpenAI GPT-4o',
    provider: 'openai',
    default_model: 'gpt-4o',
    secret_id: 'sec_01',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/ai-providers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "OpenAI GPT-4o",
    "provider": "openai",
    "default_model": "gpt-4o",
    "secret_id": "sec_01"
  }'
```

</TabItem>
</Tabs>

### List providers in a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-ai-providers --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.aiProviders.listAiProviders({
  query: { project_id: 'proj_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/ai-providers?project_id=proj_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
