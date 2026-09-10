---
description: "Connect SOAT to hosted LLM providers such as xAI, OpenAI, Anthropic, and Amazon Bedrock."
keywords:
  - OpenAI
  - Anthropic Claude
  - xAI Grok
  - Amazon Bedrock
  - LLM provider setup
  - AI provider API keys
sidebar_position: 3
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Connect Third-Party LLMs

Connect SOAT to xAI, OpenAI, Anthropic or Amazon Bedrock with [Secrets](/docs/modules/secrets#examples), [AI Providers](/docs/modules/ai-providers#examples), [Agents](/docs/modules/agents#examples) and [Sessions](/docs/modules/sessions#examples).

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)).
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.
- Credentials for at least one provider.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin bypasses policy evaluation. See [Users](/docs/modules/users#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: session, error } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

if (error) throw new Error(JSON.stringify(error));

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: session.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Every resource lives inside a [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Hosted LLM Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project, error } = await adminSoat.projects.createProject({
  body: { name: 'Hosted LLM Demo' },
});

if (error) throw new Error(JSON.stringify(error));

const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hosted LLM Demo"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Store provider credentials as secrets

[Secrets](/docs/modules/secrets#examples) are stored encrypted and referenced by ID. One secret per provider credential set.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OPENAI_SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "openai-api-key" \
  --value "sk-<your-openai-key>" | jq -r '.id')

ANTHROPIC_SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "anthropic-api-key" \
  --value "sk-ant-<your-anthropic-key>" | jq -r '.id')

XAI_SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "xai-api-key" \
  --value "xai-<your-xai-key>" | jq -r '.id')

BEDROCK_SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "bedrock-credentials" \
  --value '{"accessKeyId":"<aws-access-key-id>","secretAccessKey":"<aws-secret-access-key>","sessionToken":"<optional-session-token>"}' | jq -r '.id')
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: openAiSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-api-key',
    value: 'sk-<your-openai-key>',
  },
});

const { data: anthropicSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'anthropic-api-key',
    value: 'sk-ant-<your-anthropic-key>',
  },
});

const { data: xaiSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-api-key',
    value: 'xai-<your-xai-key>',
  },
});

const { data: bedrockSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'bedrock-credentials',
    value:
      '{"accessKeyId":"<aws-access-key-id>","secretAccessKey":"<aws-secret-access-key>","sessionToken":"<optional-session-token>"}',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OPENAI_SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"openai-api-key\",\"value\":\"sk-<your-openai-key>\"}" \
  | jq -r '.id')

XAI_SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-api-key\",\"value\":\"xai-<your-xai-key>\"}" \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Create provider records

Supported providers and options: [AI Providers](/docs/modules/ai-providers#examples). Pick the one matching your model:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# OpenAI
OPENAI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "OpenAI" \
  --provider "openai" \
  --default-model "gpt-4.1-mini" \
  --secret-id "$OPENAI_SECRET_ID" | jq -r '.id')

# Anthropic
ANTHROPIC_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Anthropic" \
  --provider "anthropic" \
  --default-model "claude-3-5-sonnet-latest" \
  --secret-id "$ANTHROPIC_SECRET_ID" | jq -r '.id')

# xAI
XAI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "xAI" \
  --provider "xai" \
  --default-model "grok-3-mini" \
  --secret-id "$XAI_SECRET_ID" | jq -r '.id')

# Bedrock (secret value can be JSON credentials, region can live in config)
BEDROCK_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Bedrock" \
  --provider "bedrock" \
  --default-model "anthropic.claude-3-5-sonnet-20240620-v1:0" \
  --secret-id "$BEDROCK_SECRET_ID" \
  --config '{"region":"us-east-1"}' | jq -r '.id')
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: openAiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'OpenAI',
    provider: 'openai',
    default_model: 'gpt-4.1-mini',
    secret_id: openAiSecret.id,
  },
});

const { data: xaiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'xAI',
    provider: 'xai',
    default_model: 'grok-3-mini',
    secret_id: xaiSecret.id,
  },
});

const { data: bedrockProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Bedrock',
    provider: 'bedrock',
    default_model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    secret_id: bedrockSecret.id,
    config: { region: 'us-east-1' },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OPENAI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"OpenAI\",\"provider\":\"openai\",\"default_model\":\"gpt-4.1-mini\",\"secret_id\":\"$OPENAI_SECRET_ID\"}" \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 5 — Create an agent

An [agent](/docs/modules/agents#examples) pointing at the provider.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$OPENAI_PROVIDER_ID" \
  --name "Hosted Assistant" \
  --instructions "You are a helpful assistant using a hosted LLM." \
  | jq -r '.id')
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: openAiProvider.id,
    name: 'Hosted Assistant',
    instructions: 'You are a helpful assistant using a hosted LLM.',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$OPENAI_PROVIDER_ID\",\"name\":\"Hosted Assistant\",\"instructions\":\"You are a helpful assistant using a hosted LLM.\"}" \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 6 — Start a conversation

A [session](/docs/modules/sessions#examples) on the provider-backed agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" | jq -r '.id')

soat add-session-message \
  --session-id "$SESSION_ID" \
  --message "Summarize why model routing matters in one paragraph."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session2 } = await adminSoat.sessions.createSession({
  body: { agent_id: agent.id },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: session2.id },
  body: { message: 'Summarize why model routing matters in one paragraph.' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize why model routing matters in one paragraph."}'
```

</TabItem>
</Tabs>

---

## What's next

- Provider rotation: several provider records in one project; switch agents between them.
- Custom gateways: `gateway` or `custom` provider types for an OpenAI-compatible upstream.
- Secret rotation: create a new secret and update the provider's `secret_id`.
