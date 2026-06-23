---
sidebar_position: 3
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Connect Third-Party LLMs

This tutorial shows how to connect SOAT to hosted LLM providers such as xAI, OpenAI, Anthropic, and Amazon Bedrock. You will:

1. Log in as admin.
2. Create a project.
3. Store provider credentials as secrets.
4. Create provider records for third-party LLMs.
5. Create an agent backed by one of those providers.
6. Start a conversation and inspect the result.

By the end you will understand how [Secrets](/docs/modules/secrets#examples), [AI Providers](/docs/modules/ai-providers#examples), [Agents](/docs/modules/agents#examples), and [Sessions](/docs/modules/sessions#examples) work together for externally hosted models.

## Prerequisites

- SOAT running locally. Follow [Quick Start](/docs/getting-started) if needed.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Server is at `http://localhost:5047`.
- Valid credentials for at least one third-party provider.

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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [Users](/docs/modules/users#examples) for full authentication and user management details.

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

Every resource in SOAT lives inside a [project](/docs/modules/projects#examples). Create one to hold the provider and agent.

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

[Secrets](/docs/modules/secrets#examples) store sensitive values encrypted; providers reference them by ID. Create one secret per provider credential set.

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

Each provider points to a hosted model endpoint. See [AI Providers](/docs/modules/ai-providers#examples) for the full list of supported providers and configuration options. Choose the provider that matches your hosted model:

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

Once the provider exists, create an [agent](/docs/modules/agents#examples) that points at it.

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

Create a [session](/docs/modules/sessions#examples) and send a message through the provider-backed agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" | jq -r '.id')

soat add-session-message \
  --agent-id "$AGENT_ID" \
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

- **Provider rotation**: Create multiple provider records in the same project and switch agents between them.
- **Custom gateways**: Use the `gateway` or `custom` provider types when you have an OpenAI-compatible upstream.
- **Production secrets**: Rotate provider secrets by creating a new secret and updating the provider's `secret_id`.
