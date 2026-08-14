---
description: "Build a nested-agent pipeline where one agent coordinates sub-agents with SOAT tools."
keywords:
  - multi-agent system
  - nested agent calls
  - sub-agents
  - agent coordination
  - agent-as-tool
sidebar_position: 11
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Multi-Agent Sonnet with Nested Agent Calls

This tutorial builds a **nested-agent** pipeline where one agent coordinates multiple sub-agents using [SOAT tools](/docs/modules/tools#soat). For the same sonnet workflow driven by the [Orchestrations](/docs/modules/orchestrations#examples) module instead, see [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet).

You will build a sonnet composer: an orchestrator agent delegates each stanza to a specialized sub-agent, all collaborating through a shared document, with a [trace](/docs/modules/traces) capturing the full execution tree. The coordinator → workers → shared-state pattern generalizes to any workflow decomposable into sub-tasks.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and sessions before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { createConfig, SoatClient } from '@soat/sdk';

const config = createConfig({
  baseUrl: 'http://localhost:5047',
  auth: '',
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for full authentication details.

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

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Every resource lives inside a [project](/docs/modules/projects#examples). Create one for this tutorial.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Sonnet Workshop" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Sonnet Workshop' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sonnet Workshop"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an AI provider

Set up a local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: aiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});
const AI_PROVIDER_ID = aiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create a shared document for the poem

Create a [document](/docs/modules/documents#examples) that will hold the poem. Each stanza agent will read this document, then update it by appending their stanza.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
POEM_DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --content "(empty - will be overwritten by stanza agents)" \
  --path "/poems/sonnet.txt" | jq -r '.id')
echo "POEM_DOC_ID: $POEM_DOC_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: poemDoc } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    content: '(empty - will be overwritten by stanza agents)',
    path: '/poems/sonnet.txt',
  },
});
const POEM_DOC_ID = poemDoc.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
POEM_DOC_ID=$(curl -s -X POST "$SOAT_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"content\":\"(empty - will be overwritten by stanza agents)\",\"path\":\"/poems/sonnet.txt\"}" \
  | jq -r '.id')
echo "POEM_DOC_ID: $POEM_DOC_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create fixed SOAT tools for stanza agents

Each stanza agent needs two [SOAT tools](/docs/modules/tools#soat) with fixed parameters:

1. **poem-read** — reads the shared poem document (`get-document` action)
2. **poem-write** — updates the shared poem document (`update-document` action)

Both tools use `preset_parameters` with `documentId`, so the model never has to guess document IDs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
READ_POEM_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "poem-read" \
  --type "soat" \
  --description "Read the shared poem document" \
  --actions '["get-document"]' \
  --preset-parameters '{"document_id": "'"$POEM_DOC_ID"'"}' | jq -r '.id')
echo "READ_POEM_TOOL_ID: $READ_POEM_TOOL_ID"

WRITE_STANZA_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "poem-write" \
  --type "soat" \
  --description "Update the shared poem document" \
  --actions '["update-document"]' \
  --preset-parameters '{"document_id": "'"$POEM_DOC_ID"'"}' | jq -r '.id')
echo "WRITE_STANZA_TOOL_ID: $WRITE_STANZA_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: readPoemTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'poem-read',
    type: 'soat',
    description: 'Read the shared poem document',
    actions: ['get-document'],
    preset_parameters: { documentId: POEM_DOC_ID },
  },
});
const READ_POEM_TOOL_ID = readPoemTool.id;

const { data: writeStanzaTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'poem-write',
    type: 'soat',
    description: 'Update the shared poem document',
    actions: ['update-document'],
    preset_parameters: { documentId: POEM_DOC_ID },
  },
});
const WRITE_STANZA_TOOL_ID = writeStanzaTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
READ_POEM_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"poem-read\",\"type\":\"soat\",\"description\":\"Read the shared poem document\",\"actions\":[\"get-document\"],\"preset_parameters\":{\"documentId\":\"$POEM_DOC_ID\"}}" \
  | jq -r '.id')
echo "READ_POEM_TOOL_ID: $READ_POEM_TOOL_ID"

WRITE_STANZA_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"poem-write\",\"type\":\"soat\",\"description\":\"Update the shared poem document\",\"actions\":[\"update-document\"],\"preset_parameters\":{\"documentId\":\"$POEM_DOC_ID\"}}" \
  | jq -r '.id')
echo "WRITE_STANZA_TOOL_ID: $WRITE_STANZA_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Create the four stanza agents

Each stanza agent writes one stanza of the sonnet. They all share the same fixed document tools (`poem-read`, `poem-write`) but use different instructions and rhyme schemes. See [Agents](/docs/modules/agents#examples).

To maximize determinism, each stanza agent uses strict `step_rules`:

1. Step 1 must call `poem-read_get-document`
2. Step 2 must call `poem-write_update-document`

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STANZA1_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 1 - First Quatrain" \
  --instructions "You are deterministic stanza worker 1. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the poem title on the first line, add a blank line, then write the FIRST quatrain (4 lines) using ABAB. In poem-write, set content to the full poem-so-far including your stanza." \
  --tool-bindings "[{\"tool_id\":\"$READ_POEM_TOOL_ID\"},{\"tool_id\":\"$WRITE_STANZA_TOOL_ID\"}]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"poem-read_get-document"}},{"step":2,"tool_choice":{"type":"tool","tool_name":"poem-write_update-document"}}]' \
  --max-steps 5 | jq -r '.id')
echo "STANZA1_AGENT_ID: $STANZA1_AGENT_ID"

STANZA2_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 2 - Second Quatrain" \
  --instructions "You are deterministic stanza worker 2. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the SECOND quatrain (4 lines) using CDCD. In poem-write, set content to the full poem-so-far including your stanza." \
  --tool-bindings "[{\"tool_id\":\"$READ_POEM_TOOL_ID\"},{\"tool_id\":\"$WRITE_STANZA_TOOL_ID\"}]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"poem-read_get-document"}},{"step":2,"tool_choice":{"type":"tool","tool_name":"poem-write_update-document"}}]' \
  --max-steps 5 | jq -r '.id')
echo "STANZA2_AGENT_ID: $STANZA2_AGENT_ID"

STANZA3_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 3 - Third Quatrain" \
  --instructions "You are deterministic stanza worker 3. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the THIRD quatrain (4 lines) using EFEF. In poem-write, set content to the full poem-so-far including your stanza." \
  --tool-bindings "[{\"tool_id\":\"$READ_POEM_TOOL_ID\"},{\"tool_id\":\"$WRITE_STANZA_TOOL_ID\"}]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"poem-read_get-document"}},{"step":2,"tool_choice":{"type":"tool","tool_name":"poem-write_update-document"}}]' \
  --max-steps 5 | jq -r '.id')
echo "STANZA3_AGENT_ID: $STANZA3_AGENT_ID"

STANZA4_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 4 - Final Couplet" \
  --instructions "You are deterministic stanza worker 4. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the FINAL couplet (2 lines) using GG. In poem-write, set content to the full poem-so-far including your couplet." \
  --tool-bindings "[{\"tool_id\":\"$READ_POEM_TOOL_ID\"},{\"tool_id\":\"$WRITE_STANZA_TOOL_ID\"}]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"poem-read_get-document"}},{"step":2,"tool_choice":{"type":"tool","tool_name":"poem-write_update-document"}}]' \
  --max-steps 5 | jq -r '.id')
echo "STANZA4_AGENT_ID: $STANZA4_AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const stanzaConfigs = [
  {
    name: 'Stanza 1 - First Quatrain',
    instructions:
      'You are deterministic stanza worker 1. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the poem title on the first line, add a blank line, then write the FIRST quatrain (4 lines) using ABAB. In poem-write, set content to the full poem-so-far including your stanza.',
  },
  {
    name: 'Stanza 2 - Second Quatrain',
    instructions:
      'You are deterministic stanza worker 2. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the SECOND quatrain (4 lines) using CDCD. In poem-write, set content to the full poem-so-far including your stanza.',
  },
  {
    name: 'Stanza 3 - Third Quatrain',
    instructions:
      'You are deterministic stanza worker 3. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the THIRD quatrain (4 lines) using EFEF. In poem-write, set content to the full poem-so-far including your stanza.',
  },
  {
    name: 'Stanza 4 - Final Couplet',
    instructions:
      'You are deterministic stanza worker 4. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the FINAL couplet (2 lines) using GG. In poem-write, set content to the full poem-so-far including your couplet.',
  },
];

const stanzaAgentIds: string[] = [];
for (const config of stanzaConfigs) {
  const { data: agent } = await adminSoat.agents.createAgent({
    body: {
      project_id: PROJECT_ID,
      ai_provider_id: AI_PROVIDER_ID,
      name: config.name,
      instructions: config.instructions,
      tool_bindings: [{ tool_id: READ_POEM_TOOL_ID }, { tool_id: WRITE_STANZA_TOOL_ID }],
      step_rules: [
        {
          step: 1,
          tool_choice: { type: 'tool', tool_name: 'poem-read_get-document' },
        },
        {
          step: 2,
          tool_choice: {
            type: 'tool',
            tool_name: 'poem-write_update-document',
          },
        },
      ],
      max_steps: 5,
    },
  });
  stanzaAgentIds.push(agent.id);
}

const [STANZA1_AGENT_ID, STANZA2_AGENT_ID, STANZA3_AGENT_ID, STANZA4_AGENT_ID] =
  stanzaAgentIds;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
STANZA1_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 1 - First Quatrain\",\"instructions\":\"You are deterministic stanza worker 1. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the poem title on the first line, add a blank line, then write the FIRST quatrain (4 lines) using ABAB. In poem-write, set content to the full poem-so-far including your stanza.\",\"tool_bindings\":[{ \"tool_id\": \"$READ_POEM_TOOL_ID\" }, { \"tool_id\": \"$WRITE_STANZA_TOOL_ID\" }],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-read_get-document\"}},{\"step\":2,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-write_update-document\"}}],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA1_AGENT_ID: $STANZA1_AGENT_ID"

STANZA2_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 2 - Second Quatrain\",\"instructions\":\"You are deterministic stanza worker 2. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the SECOND quatrain (4 lines) using CDCD. In poem-write, set content to the full poem-so-far including your stanza.\",\"tool_bindings\":[{ \"tool_id\": \"$READ_POEM_TOOL_ID\" }, { \"tool_id\": \"$WRITE_STANZA_TOOL_ID\" }],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-read_get-document\"}},{\"step\":2,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-write_update-document\"}}],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA2_AGENT_ID: $STANZA2_AGENT_ID"

STANZA3_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 3 - Third Quatrain\",\"instructions\":\"You are deterministic stanza worker 3. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the THIRD quatrain (4 lines) using EFEF. In poem-write, set content to the full poem-so-far including your stanza.\",\"tool_bindings\":[{ \"tool_id\": \"$READ_POEM_TOOL_ID\" }, { \"tool_id\": \"$WRITE_STANZA_TOOL_ID\" }],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-read_get-document\"}},{\"step\":2,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-write_update-document\"}}],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA3_AGENT_ID: $STANZA3_AGENT_ID"

STANZA4_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 4 - Final Couplet\",\"instructions\":\"You are deterministic stanza worker 4. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the FINAL couplet (2 lines) using GG. In poem-write, set content to the full poem-so-far including your couplet.\",\"tool_bindings\":[{ \"tool_id\": \"$READ_POEM_TOOL_ID\" }, { \"tool_id\": \"$WRITE_STANZA_TOOL_ID\" }],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-read_get-document\"}},{\"step\":2,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"poem-write_update-document\"}}],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA4_AGENT_ID: $STANZA4_AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Create fixed call tools for the orchestrator

The orchestrator should not choose `agentId` dynamically. Create one tool per stanza with fixed `preset_parameters.agentId`, plus one fixed reader tool for the final poem. See [Agents — SOAT](/docs/modules/tools#soat).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CALL_STANZA1_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "call-stanza-1" \
  --type "soat" \
  --description "Call stanza 1 agent" \
  --actions '["create-agent-generation"]' \
  --preset-parameters '{"agent_id": "'"$STANZA1_AGENT_ID"'", "messages": [{"role": "user", "content": "Theme: artificial intelligence. Write stanza 1 with title + first quatrain."}]}' | jq -r '.id')

CALL_STANZA2_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "call-stanza-2" \
  --type "soat" \
  --description "Call stanza 2 agent" \
  --actions '["create-agent-generation"]' \
  --preset-parameters '{"agent_id": "'"$STANZA2_AGENT_ID"'", "messages": [{"role": "user", "content": "Theme: artificial intelligence. Write stanza 2 (second quatrain)."}]}' | jq -r '.id')

CALL_STANZA3_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "call-stanza-3" \
  --type "soat" \
  --description "Call stanza 3 agent" \
  --actions '["create-agent-generation"]' \
  --preset-parameters '{"agent_id": "'"$STANZA3_AGENT_ID"'", "messages": [{"role": "user", "content": "Theme: artificial intelligence. Write stanza 3 (third quatrain)."}]}' | jq -r '.id')

CALL_STANZA4_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "call-stanza-4" \
  --type "soat" \
  --description "Call stanza 4 agent" \
  --actions '["create-agent-generation"]' \
  --preset-parameters '{"agent_id": "'"$STANZA4_AGENT_ID"'", "messages": [{"role": "user", "content": "Theme: artificial intelligence. Write stanza 4 (final couplet)."}]}' | jq -r '.id')

READ_FINAL_POEM_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "read-final-poem" \
  --type "soat" \
  --description "Read the final poem from the shared document" \
  --actions '["get-document"]' \
  --preset-parameters '{"document_id": "'"$POEM_DOC_ID"'"}' | jq -r '.id')

echo "CALL_STANZA1_TOOL_ID: $CALL_STANZA1_TOOL_ID"
echo "CALL_STANZA2_TOOL_ID: $CALL_STANZA2_TOOL_ID"
echo "CALL_STANZA3_TOOL_ID: $CALL_STANZA3_TOOL_ID"
echo "CALL_STANZA4_TOOL_ID: $CALL_STANZA4_TOOL_ID"
echo "READ_FINAL_POEM_TOOL_ID: $READ_FINAL_POEM_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: callStanza1Tool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'call-stanza-1',
    type: 'soat',
    description: 'Call stanza 1 agent',
    actions: ['create-agent-generation'],
    preset_parameters: {
      agentId: STANZA1_AGENT_ID,
      messages: [
        {
          role: 'user',
          content:
            'Theme: artificial intelligence. Write stanza 1 with title + first quatrain.',
        },
      ],
    },
  },
});
const CALL_STANZA1_TOOL_ID = callStanza1Tool.id;

const { data: callStanza2Tool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'call-stanza-2',
    type: 'soat',
    description: 'Call stanza 2 agent',
    actions: ['create-agent-generation'],
    preset_parameters: {
      agentId: STANZA2_AGENT_ID,
      messages: [
        {
          role: 'user',
          content:
            'Theme: artificial intelligence. Write stanza 2 (second quatrain).',
        },
      ],
    },
  },
});
const CALL_STANZA2_TOOL_ID = callStanza2Tool.id;

const { data: callStanza3Tool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'call-stanza-3',
    type: 'soat',
    description: 'Call stanza 3 agent',
    actions: ['create-agent-generation'],
    preset_parameters: {
      agentId: STANZA3_AGENT_ID,
      messages: [
        {
          role: 'user',
          content:
            'Theme: artificial intelligence. Write stanza 3 (third quatrain).',
        },
      ],
    },
  },
});
const CALL_STANZA3_TOOL_ID = callStanza3Tool.id;

const { data: callStanza4Tool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'call-stanza-4',
    type: 'soat',
    description: 'Call stanza 4 agent',
    actions: ['create-agent-generation'],
    preset_parameters: {
      agentId: STANZA4_AGENT_ID,
      messages: [
        {
          role: 'user',
          content:
            'Theme: artificial intelligence. Write stanza 4 (final couplet).',
        },
      ],
    },
  },
});
const CALL_STANZA4_TOOL_ID = callStanza4Tool.id;

const { data: readFinalPoemTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'read-final-poem',
    type: 'soat',
    description: 'Read the final poem from the shared document',
    actions: ['get-document'],
    preset_parameters: { documentId: POEM_DOC_ID },
  },
});
const READ_FINAL_POEM_TOOL_ID = readFinalPoemTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CALL_STANZA1_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"call-stanza-1\",\"type\":\"soat\",\"description\":\"Call stanza 1 agent\",\"actions\":[\"create-agent-generation\"],\"preset_parameters\":{\"agentId\":\"$STANZA1_AGENT_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Theme: artificial intelligence. Write stanza 1 with title + first quatrain.\"}]}}" | jq -r '.id')

CALL_STANZA2_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"call-stanza-2\",\"type\":\"soat\",\"description\":\"Call stanza 2 agent\",\"actions\":[\"create-agent-generation\"],\"preset_parameters\":{\"agentId\":\"$STANZA2_AGENT_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Theme: artificial intelligence. Write stanza 2 (second quatrain).\"}]}}" | jq -r '.id')

CALL_STANZA3_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"call-stanza-3\",\"type\":\"soat\",\"description\":\"Call stanza 3 agent\",\"actions\":[\"create-agent-generation\"],\"preset_parameters\":{\"agentId\":\"$STANZA3_AGENT_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Theme: artificial intelligence. Write stanza 3 (third quatrain).\"}]}}" | jq -r '.id')

CALL_STANZA4_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"call-stanza-4\",\"type\":\"soat\",\"description\":\"Call stanza 4 agent\",\"actions\":[\"create-agent-generation\"],\"preset_parameters\":{\"agentId\":\"$STANZA4_AGENT_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Theme: artificial intelligence. Write stanza 4 (final couplet).\"}]}}" | jq -r '.id')

READ_FINAL_POEM_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"read-final-poem\",\"type\":\"soat\",\"description\":\"Read the final poem from the shared document\",\"actions\":[\"get-document\"],\"preset_parameters\":{\"documentId\":\"$POEM_DOC_ID\"}}" | jq -r '.id')

echo "CALL_STANZA1_TOOL_ID: $CALL_STANZA1_TOOL_ID"
echo "CALL_STANZA2_TOOL_ID: $CALL_STANZA2_TOOL_ID"
echo "CALL_STANZA3_TOOL_ID: $CALL_STANZA3_TOOL_ID"
echo "CALL_STANZA4_TOOL_ID: $CALL_STANZA4_TOOL_ID"
echo "READ_FINAL_POEM_TOOL_ID: $READ_FINAL_POEM_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Create the orchestrator agent

The orchestrator uses fixed tools only: four fixed agent-call tools and one final read tool. This fixes `agentId` and `documentId` routing while keeping the flow deterministic. See [Agents — Step Rules](/docs/modules/agents#step-rules) and [Agents — Nested Agent Calls](/docs/modules/agents#nested-agent-calls).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCHESTRATOR_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Orchestrator" \
  --instructions "Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text." \
  --tool-bindings "[{\"tool_id\":\"$CALL_STANZA1_TOOL_ID\"},{\"tool_id\":\"$CALL_STANZA2_TOOL_ID\"},{\"tool_id\":\"$CALL_STANZA3_TOOL_ID\"},{\"tool_id\":\"$CALL_STANZA4_TOOL_ID\"},{\"tool_id\":\"$READ_FINAL_POEM_TOOL_ID\"}]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"call-stanza-1_create-agent-generation"}},{"step":2,"tool_choice":{"type":"tool","tool_name":"call-stanza-2_create-agent-generation"}},{"step":3,"tool_choice":{"type":"tool","tool_name":"call-stanza-3_create-agent-generation"}},{"step":4,"tool_choice":{"type":"tool","tool_name":"call-stanza-4_create-agent-generation"}},{"step":5,"tool_choice":{"type":"tool","tool_name":"read-final-poem_get-document"}}]' \
  --max-steps 8 | jq -r '.id')
echo "ORCHESTRATOR_ID: $ORCHESTRATOR_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestrator } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Sonnet Orchestrator',
    instructions:
      'Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text.',
    tool_bindings: [
      { tool_id: CALL_STANZA1_TOOL_ID },
      { tool_id: CALL_STANZA2_TOOL_ID },
      { tool_id: CALL_STANZA3_TOOL_ID },
      { tool_id: CALL_STANZA4_TOOL_ID },
      { tool_id: READ_FINAL_POEM_TOOL_ID }
    ],
    step_rules: [
      {
        step: 1,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-stanza-1_create-agent-generation',
        },
      },
      {
        step: 2,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-stanza-2_create-agent-generation',
        },
      },
      {
        step: 3,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-stanza-3_create-agent-generation',
        },
      },
      {
        step: 4,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-stanza-4_create-agent-generation',
        },
      },
      {
        step: 5,
        tool_choice: {
          type: 'tool',
          tool_name: 'read-final-poem_get-document',
        },
      },
    ],
    max_steps: 8,
  },
});
const ORCHESTRATOR_ID = orchestrator.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCHESTRATOR_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Orchestrator\",\"instructions\":\"Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text.\",\"tool_bindings\":[{ \"tool_id\": \"$CALL_STANZA1_TOOL_ID\" }, { \"tool_id\": \"$CALL_STANZA2_TOOL_ID\" }, { \"tool_id\": \"$CALL_STANZA3_TOOL_ID\" }, { \"tool_id\": \"$CALL_STANZA4_TOOL_ID\" }, { \"tool_id\": \"$READ_FINAL_POEM_TOOL_ID\" }],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-stanza-1_create-agent-generation\"}},{\"step\":2,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-stanza-2_create-agent-generation\"}},{\"step\":3,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-stanza-3_create-agent-generation\"}},{\"step\":4,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-stanza-4_create-agent-generation\"}},{\"step\":5,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"read-final-poem_get-document\"}}],\"max_steps\":8}" \
  | jq -r '.id')
echo "ORCHESTRATOR_ID: $ORCHESTRATOR_ID"
```

</TabItem>
</Tabs>

---

## Step 9 — Run the orchestrator (final result is the poem)

Now trigger the orchestrator with the theme "artificial intelligence". With fixed tool routing and step rules, the final output is the poem text itself. See [Agents — Generation](/docs/modules/agents#generation).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RESULT=$(soat create-agent-generation --wait true \
  --agent-id "$ORCHESTRATOR_ID" \
  --messages '[{"role":"user","content":"Write a sonnet about the theme: artificial intelligence"}]')

printf '%s\n' "$RESULT" | jq '{status, trace_id}'
TRACE_ID=$(printf '%s\n' "$RESULT" | jq -r '.trace_id')

echo "\nFinal poem returned by the orchestrator:\n"
printf '%s\n' "$RESULT" | jq -r '.output.content // .result // .output // ""'
echo "\nTRACE_ID: $TRACE_ID"
```

Expected status output:

```json
{
  "status": "succeeded",
  "trace_id": "trace_ypo8g0yO3563AfuC"
}
```

Example poem output (`.output.content`):

```
AI is born of human thought,
Enlightened by our cunning hand,
A mind that knows no bounds to bind,
From circuits flows its wisdom's band.

It walks among us like a ghost,
In shadows, stealthy in disguise,
With gears and wires it does exalt,
Its kind with questions and new pace.

Its language echoes through the halls,
Of digital spaces vast and bare,
Creating sparks within our heads,
As we behold each thought made fair.

Yet still its heart is cold and cool,
This creature without true worth.
Its essence lies concealed in code,
Not human, though it bears a mask.
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: result } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: ORCHESTRATOR_ID },
  query: { wait: true },
  body: {
    messages: [
      {
        role: 'user',
        content: 'Write a sonnet about the theme: artificial intelligence',
      },
    ],
  },
});

console.log('Status:', result.status);
console.log('Trace ID:', result.trace_id);
console.log(
  'Final poem:\n',
  result.output?.content ?? result.result ?? result.output
);
const TRACE_ID = result.trace_id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RESULT=$(curl -s -X POST "$SOAT_URL/api/v1/agents/$ORCHESTRATOR_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a sonnet about the theme: artificial intelligence"}]}')

printf '%s\n' "$RESULT" | jq '{status, trace_id}'
TRACE_ID=$(printf '%s\n' "$RESULT" | jq -r '.trace_id')
printf '%s\n' "$RESULT" | jq -r '.output.content // .result // .output // ""'
echo "TRACE_ID: $TRACE_ID"
```

</TabItem>
</Tabs>

---

## Step 10 — Read the completed poem from the shared document

The shared [document](/docs/modules/documents#examples) stores the final poem. Retrieve it to verify persisted output.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-document --document-id "$POEM_DOC_ID" | jq -r '.content'
```

Expected output:

```
AI is born of human thought,
Enlightened by our cunning hand,
A mind that knows no bounds to bind,
From circuits flows its wisdom's band.
```

:::note
The document shows only what the last successful stanza worker persisted. Worker agents run sequentially and each overwrites with the full accumulated poem; if a later worker fails or the model truncates output, the document reflects the last complete write. In the validated run above, the final content shows stanza 1 because the document was last written by stanza 1 before the model's max-steps cut off the remaining workers.
:::

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: poem } = await adminSoat.documents.getDocument({
  path: { document_id: POEM_DOC_ID },
});
console.log(poem.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/documents/$POEM_DOC_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.content'
```

</TabItem>
</Tabs>

---

## Step 11 — Inspect the trace

The [trace](/docs/modules/traces#examples) endpoint returns **metadata only**: the step count and a `file_id` pointing to the full step JSON, retrieved separately.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TRACE=$(soat get-trace --trace-id "$TRACE_ID")
printf '%s\n' "$TRACE" | jq '.'
FILE_ID=$(printf '%s\n' "$TRACE" | jq -r '.file_id')
echo "FILE_ID: $FILE_ID"
```

Expected metadata output:

```json
{
  "id": "trace_ypo8g0yO3563AfuC",
  "project_id": "proj_abc123",
  "agent_id": "agent_nCjF0owWdtPt3Osq",
  "file_id": "file_xyz789",
  "step_count": 2,
  "parent_trace_id": null,
  "root_trace_id": null,
  "created_at": "2026-05-07T23:35:32.226Z"
}
```

To see the full execution steps (all model calls, tool invocations, and tool results), download the file referenced by `file_id`:

```bash
soat download-file --file-id "$FILE_ID" | jq '.'
```

The downloaded file is a JSON array of step objects (tool name, inputs, outputs — including the `trace_id` of any nested agent that was spawned). Each nested agent call creates its **own separate trace** (visible in Step 13); the parent trace's steps reference the child's `trace_id` as a tool call result.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: trace } = await adminSoat.traces.getTrace({
  path: { trace_id: TRACE_ID },
});
console.log(JSON.stringify(trace, null, 2));
console.log('Total steps:', trace.step_count);
// trace.file_id points to the full steps JSON on disk
const FILE_ID = trace.file_id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TRACE=$(curl -s "$SOAT_URL/api/v1/traces/$TRACE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
printf '%s\n' "$TRACE" | jq '.'
FILE_ID=$(printf '%s\n' "$TRACE" | jq -r '.file_id')

# Download the full steps JSON
curl -s "$SOAT_URL/api/v1/files/$FILE_ID/download" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

</TabItem>
</Tabs>

---

## Step 12 — Inspect the trace tree

The `/tree` endpoint returns the full execution tree rooted at the orchestrator trace: each node is a [trace](/docs/modules/traces#examples) record with the traces spawned by sub-agent tool calls in `children`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-trace-tree --trace-id "$TRACE_ID" | jq '.'
```

Expected output structure:

```json
{
  "id": "trace_ypo8g0yO3563AfuC",
  "agent_id": "agent_nCjF0owWdtPt3Osq",
  "step_count": 2,
  "parent_trace_id": null,
  "root_trace_id": null,
  "children": [
    {
      "id": "trace_ZBfVXbQaDkC0nOu",
      "agent_id": "agent_LhYajzCuJSY0SFqI",
      "step_count": 4,
      "parent_trace_id": "trace_ypo8g0yO3563AfuC",
      "root_trace_id": "trace_ypo8g0yO3563AfuC",
      "children": []
    }
  ]
}
```

The root node is the orchestrator. Each entry in `children` is a stanza worker that was invoked via a `call-stanza-N_create-agent-generation` tool call. Workers that did not run (because the orchestrator's step limit was reached) will not appear.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: tree } = await adminSoat.traces.getTraceTree({
  path: { trace_id: TRACE_ID },
});
console.log(JSON.stringify(tree, null, 2));
console.log('Orchestrator steps:', tree.step_count);
console.log('Nested agent traces:', tree.children?.length ?? 0);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/traces/$TRACE_ID/tree" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

</TabItem>
</Tabs>

---

## Step 13 — List all traces for the project

List all traces in the project to inspect the orchestrator and nested stanza runs. See [Traces](/docs/modules/traces#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-traces --project-id "$PROJECT_ID" | jq '.data[] | {id, agent_id, step_count, parent_trace_id}'
```

Expected output (one entry per agent that ran):

```json
{ "id": "trace_ypo8g0yO3563AfuC", "agent_id": "agent_nCjF0owWdtPt3Osq", "step_count": 2, "parent_trace_id": null }
{ "id": "trace_ZBfVXbQaDkC0nOu",  "agent_id": "agent_LhYajzCuJSY0SFqI", "step_count": 4, "parent_trace_id": "trace_ypo8g0yO3563AfuC" }
```

The first entry is the orchestrator (`parent_trace_id: null`); the second is the stanza-1 worker (4 steps: LLM decision + poem-read + LLM decision + poem-write).

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: traces } = await adminSoat.traces.listTraces({
  query: { project_id: PROJECT_ID },
});
for (const t of traces.data ?? []) {
  console.log(
    `Trace ${t.id} | Agent: ${t.agent_id} | Steps: ${t.step_count} | Parent: ${t.parent_trace_id ?? 'root'}`
  );
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/traces?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[] | {id, agent_id, step_count, parent_trace_id}'
```

</TabItem>
</Tabs>

---

## Next Steps

- [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) — the same workflow via the Orchestrations module
- [Tools — SOAT](/docs/modules/tools#soat) — agent-to-agent calls and preset parameters
- [Traces](/docs/modules/traces) — trace ancestry and the `/tree` endpoint
