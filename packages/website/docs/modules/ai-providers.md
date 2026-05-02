import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# AI Providers

The AI Providers module lets you register and manage LLM provider configurations for a project. Each provider record stores the model slug, optional base URL, optional configuration, and an optional link to a [Secret](./secrets.md) that supplies the API key.

## Overview

An AI provider is a named configuration that tells the system how to reach a specific LLM endpoint. A project can have multiple providers — for example, one for GPT-4o and another for Claude 3.5.

When a provider is linked to a secret the secret's encrypted value is retrieved and passed as the API key when calling the LLM. The key is never exposed through the API.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

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
