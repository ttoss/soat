---
sidebar_position: 4
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestrate a Sonnet

This tutorial shows how to build a poem pipeline with the [Orchestrations](/docs/modules/orchestrations#examples) module. Unlike [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration), the agents here do not call one another. The orchestration graph invokes each agent directly, stores their outputs in typed state, assembles the final poem, and persists it through a SOAT tool.

You will:

1. Create a project, an AI provider, and a shared [document](/docs/modules/documents#examples) for the poem.
2. Create one fixed SOAT tool that writes the finished poem to that document.
3. Create five specialized [agents](/docs/modules/agents#examples): one for the title and four for the sonnet sections.
4. Define an [orchestration](/docs/modules/orchestrations#examples) whose `agent` nodes call those agents in sequence.
5. Run the orchestration with a theme and inspect both the persisted document and the run state.

By the end you will understand how orchestration state, direct agent nodes, transform nodes, and tool nodes compose into a deterministic content pipeline.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, tools, and runs before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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
export SOAT_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for authentication details.

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

Every resource lives inside a [project](/docs/modules/projects#examples). Create one for this workflow.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Orchestrated Sonnet" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Orchestrated Sonnet' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Orchestrated Sonnet"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an AI provider

Create a local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama.

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

## Step 4 — Create the poem document and a fixed write tool

The final poem will be persisted in a [document](/docs/modules/documents#examples). A fixed [SOAT tool](/docs/modules/agents#soat) will later update that document from the orchestration.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
POEM_DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --content "(empty - orchestration will write the poem)" \
  --path "/poems/orchestrated-sonnet.txt" | jq -r '.id')
echo "POEM_DOC_ID: $POEM_DOC_ID"

WRITE_POEM_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "persist-poem" \
  --type "soat" \
  --description "Write the completed poem to the shared document" \
  --actions '["update-document"]' \
  --preset-parameters '{"documentId": "'"$POEM_DOC_ID"'"}' | jq -r '.id')
echo "WRITE_POEM_TOOL_ID: $WRITE_POEM_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: poemDoc } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    content: '(empty - orchestration will write the poem)',
    path: '/poems/orchestrated-sonnet.txt',
  },
});
const POEM_DOC_ID = poemDoc.id;

const { data: writePoemTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'persist-poem',
    type: 'soat',
    description: 'Write the completed poem to the shared document',
    actions: ['update-document'],
    preset_parameters: { documentId: POEM_DOC_ID },
  },
});
const WRITE_POEM_TOOL_ID = writePoemTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
POEM_DOC_ID=$(curl -s -X POST "$SOAT_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"content\":\"(empty - orchestration will write the poem)\",\"path\":\"/poems/orchestrated-sonnet.txt\"}" \
  | jq -r '.id')
echo "POEM_DOC_ID: $POEM_DOC_ID"

WRITE_POEM_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"persist-poem\",\"type\":\"soat\",\"description\":\"Write the completed poem to the shared document\",\"actions\":[\"update-document\"],\"preset_parameters\":{\"documentId\":\"$POEM_DOC_ID\"}}" \
  | jq -r '.id')
echo "WRITE_POEM_TOOL_ID: $WRITE_POEM_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create the title and stanza agents

Create five [agents](/docs/modules/agents#examples): one returns the title as JSON, and four return a stanza or couplet as JSON. The orchestration will call them directly in order.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TITLE_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Title Agent" \
  --instructions 'You receive context lines such as theme: "...". Return ONLY compact JSON matching {"title":"..."}. Create a short poetic sonnet title about the theme. No markdown, no code fences.' \
  --max-steps 1 | jq -r '.id')

STANZA1_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Stanza 1 Agent" \
  --instructions 'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the first quatrain of a sonnet using ABAB rhyme. Exactly 4 lines. Do not repeat previous text.' \
  --max-steps 1 | jq -r '.id')

STANZA2_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Stanza 2 Agent" \
  --instructions 'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the second quatrain of a sonnet using CDCD rhyme. Exactly 4 lines. Do not repeat previous text.' \
  --max-steps 1 | jq -r '.id')

STANZA3_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Stanza 3 Agent" \
  --instructions 'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the third quatrain of a sonnet using EFEF rhyme. Exactly 4 lines. Do not repeat previous text.' \
  --max-steps 1 | jq -r '.id')

STANZA4_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Couplet Agent" \
  --instructions 'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the final couplet of a sonnet using GG rhyme. Exactly 2 lines. Do not repeat previous text.' \
  --max-steps 1 | jq -r '.id')

echo "TITLE_AGENT_ID: $TITLE_AGENT_ID"
echo "STANZA1_AGENT_ID: $STANZA1_AGENT_ID"
echo "STANZA2_AGENT_ID: $STANZA2_AGENT_ID"
echo "STANZA3_AGENT_ID: $STANZA3_AGENT_ID"
echo "STANZA4_AGENT_ID: $STANZA4_AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: titleAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Sonnet Title Agent',
    instructions:
      'You receive context lines such as theme: "...". Return ONLY compact JSON matching {"title":"..."}. Create a short poetic sonnet title about the theme. No markdown, no code fences.',
    max_steps: 1,
  },
});
const TITLE_AGENT_ID = titleAgent.id;

const stanzaAgentConfigs = [
  {
    name: 'Sonnet Stanza 1 Agent',
    instructions:
      'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the first quatrain of a sonnet using ABAB rhyme. Exactly 4 lines. Do not repeat previous text.',
  },
  {
    name: 'Sonnet Stanza 2 Agent',
    instructions:
      'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the second quatrain of a sonnet using CDCD rhyme. Exactly 4 lines. Do not repeat previous text.',
  },
  {
    name: 'Sonnet Stanza 3 Agent',
    instructions:
      'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the third quatrain of a sonnet using EFEF rhyme. Exactly 4 lines. Do not repeat previous text.',
  },
  {
    name: 'Sonnet Couplet Agent',
    instructions:
      'You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {"stanza":"..."}. Write the final couplet of a sonnet using GG rhyme. Exactly 2 lines. Do not repeat previous text.',
  },
];

const stanzaAgentIds: string[] = [];
for (const config of stanzaAgentConfigs) {
  const { data: agent } = await adminSoat.agents.createAgent({
    body: {
      project_id: PROJECT_ID,
      ai_provider_id: AI_PROVIDER_ID,
      name: config.name,
      instructions: config.instructions,
      max_steps: 1,
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
TITLE_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Title Agent\",\"instructions\":\"You receive context lines such as theme: \\\"...\\\". Return ONLY compact JSON matching {\\\"title\\\":\\\"...\\\"}. Create a short poetic sonnet title about the theme. No markdown, no code fences.\",\"max_steps\":1}" \
  | jq -r '.id')

STANZA1_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Stanza 1 Agent\",\"instructions\":\"You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {\\\"stanza\\\":\\\"...\\\"}. Write the first quatrain of a sonnet using ABAB rhyme. Exactly 4 lines. Do not repeat previous text.\",\"max_steps\":1}" \
  | jq -r '.id')

STANZA2_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Stanza 2 Agent\",\"instructions\":\"You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {\\\"stanza\\\":\\\"...\\\"}. Write the second quatrain of a sonnet using CDCD rhyme. Exactly 4 lines. Do not repeat previous text.\",\"max_steps\":1}" \
  | jq -r '.id')

STANZA3_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Stanza 3 Agent\",\"instructions\":\"You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {\\\"stanza\\\":\\\"...\\\"}. Write the third quatrain of a sonnet using EFEF rhyme. Exactly 4 lines. Do not repeat previous text.\",\"max_steps\":1}" \
  | jq -r '.id')

STANZA4_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Couplet Agent\",\"instructions\":\"You receive context lines such as theme, title, and previous stanzas. Return ONLY compact JSON matching {\\\"stanza\\\":\\\"...\\\"}. Write the final couplet of a sonnet using GG rhyme. Exactly 2 lines. Do not repeat previous text.\",\"max_steps\":1}" \
  | jq -r '.id')

echo "TITLE_AGENT_ID: $TITLE_AGENT_ID"
echo "STANZA1_AGENT_ID: $STANZA1_AGENT_ID"
echo "STANZA2_AGENT_ID: $STANZA2_AGENT_ID"
echo "STANZA3_AGENT_ID: $STANZA3_AGENT_ID"
echo "STANZA4_AGENT_ID: $STANZA4_AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Create the orchestration graph

This [orchestration](/docs/modules/orchestrations#examples) stores every agent result in state, assembles the poem with a `transform` node, writes it with a `tool` node, and exposes it again through a terminal `return-poem` node.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_NODES='[
  {
    "id": "generate-title",
    "type": "agent",
    "agent_id": "'"$TITLE_AGENT_ID"'",
    "input_mapping": {"theme": "state.theme"},
    "output_schema": {"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}}},
    "output_mapping": {"title": "state.title"}
  },
  {
    "id": "generate-stanza-1",
    "type": "agent",
    "agent_id": "'"$STANZA1_AGENT_ID"'",
    "input_mapping": {"theme": "state.theme", "title": "state.title"},
    "output_schema": {"type": "object", "required": ["stanza"], "properties": {"stanza": {"type": "string"}}},
    "output_mapping": {"stanza": "state.stanza1"}
  },
  {
    "id": "generate-stanza-2",
    "type": "agent",
    "agent_id": "'"$STANZA2_AGENT_ID"'",
    "input_mapping": {"theme": "state.theme", "title": "state.title", "stanza1": "state.stanza1"},
    "output_schema": {"type": "object", "required": ["stanza"], "properties": {"stanza": {"type": "string"}}},
    "output_mapping": {"stanza": "state.stanza2"}
  },
  {
    "id": "generate-stanza-3",
    "type": "agent",
    "agent_id": "'"$STANZA3_AGENT_ID"'",
    "input_mapping": {"theme": "state.theme", "title": "state.title", "stanza1": "state.stanza1", "stanza2": "state.stanza2"},
    "output_schema": {"type": "object", "required": ["stanza"], "properties": {"stanza": {"type": "string"}}},
    "output_mapping": {"stanza": "state.stanza3"}
  },
  {
    "id": "generate-stanza-4",
    "type": "agent",
    "agent_id": "'"$STANZA4_AGENT_ID"'",
    "input_mapping": {"theme": "state.theme", "title": "state.title", "stanza1": "state.stanza1", "stanza2": "state.stanza2", "stanza3": "state.stanza3"},
    "output_schema": {"type": "object", "required": ["stanza"], "properties": {"stanza": {"type": "string"}}},
    "output_mapping": {"stanza": "state.stanza4"}
  },
  {
    "id": "assemble-poem",
    "type": "transform",
    "expression": {"cat": [{"var": "title"}, "\n\n", {"var": "stanza1"}, "\n\n", {"var": "stanza2"}, "\n\n", {"var": "stanza3"}, "\n\n", {"var": "stanza4"}]},
    "output_mapping": {"result": "state.poem"}
  },
  {
    "id": "persist-poem",
    "type": "tool",
    "tool_id": "'"$WRITE_POEM_TOOL_ID"'",
    "operation_id": "update-document",
    "input_mapping": {"content": "state.poem"}
  },
  {
    "id": "return-poem",
    "type": "transform",
    "expression": {"var": "poem"}
  }
]'

ORCH_EDGES='[
  {"from": "generate-title", "to": "generate-stanza-1"},
  {"from": "generate-stanza-1", "to": "generate-stanza-2"},
  {"from": "generate-stanza-2", "to": "generate-stanza-3"},
  {"from": "generate-stanza-3", "to": "generate-stanza-4"},
  {"from": "generate-stanza-4", "to": "assemble-poem"},
  {"from": "assemble-poem", "to": "persist-poem"},
  {"from": "assemble-poem", "to": "return-poem"}
]'

ORCHESTRATION_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Direct Sonnet Orchestration" \
  --description "Direct agent-node sonnet pipeline" \
  --nodes "$ORCH_NODES" \
  --edges "$ORCH_EDGES" | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestration } =
  await adminSoat.orchestrations.createOrchestration({
    body: {
      project_id: PROJECT_ID,
      name: 'Direct Sonnet Orchestration',
      description: 'Direct agent-node sonnet pipeline',
      nodes: [
        {
          id: 'generate-title',
          type: 'agent',
          agent_id: TITLE_AGENT_ID,
          input_mapping: { theme: 'state.theme' },
          output_schema: {
            type: 'object',
            required: ['title'],
            properties: { title: { type: 'string' } },
          },
          output_mapping: { title: 'state.title' },
        },
        {
          id: 'generate-stanza-1',
          type: 'agent',
          agent_id: STANZA1_AGENT_ID,
          input_mapping: { theme: 'state.theme', title: 'state.title' },
          output_schema: {
            type: 'object',
            required: ['stanza'],
            properties: { stanza: { type: 'string' } },
          },
          output_mapping: { stanza: 'state.stanza1' },
        },
        {
          id: 'generate-stanza-2',
          type: 'agent',
          agent_id: STANZA2_AGENT_ID,
          input_mapping: {
            theme: 'state.theme',
            title: 'state.title',
            stanza1: 'state.stanza1',
          },
          output_schema: {
            type: 'object',
            required: ['stanza'],
            properties: { stanza: { type: 'string' } },
          },
          output_mapping: { stanza: 'state.stanza2' },
        },
        {
          id: 'generate-stanza-3',
          type: 'agent',
          agent_id: STANZA3_AGENT_ID,
          input_mapping: {
            theme: 'state.theme',
            title: 'state.title',
            stanza1: 'state.stanza1',
            stanza2: 'state.stanza2',
          },
          output_schema: {
            type: 'object',
            required: ['stanza'],
            properties: { stanza: { type: 'string' } },
          },
          output_mapping: { stanza: 'state.stanza3' },
        },
        {
          id: 'generate-stanza-4',
          type: 'agent',
          agent_id: STANZA4_AGENT_ID,
          input_mapping: {
            theme: 'state.theme',
            title: 'state.title',
            stanza1: 'state.stanza1',
            stanza2: 'state.stanza2',
            stanza3: 'state.stanza3',
          },
          output_schema: {
            type: 'object',
            required: ['stanza'],
            properties: { stanza: { type: 'string' } },
          },
          output_mapping: { stanza: 'state.stanza4' },
        },
        {
          id: 'assemble-poem',
          type: 'transform',
          expression: {
            cat: [
              { var: 'title' },
              '\n\n',
              { var: 'stanza1' },
              '\n\n',
              { var: 'stanza2' },
              '\n\n',
              { var: 'stanza3' },
              '\n\n',
              { var: 'stanza4' },
            ],
          },
          output_mapping: { result: 'state.poem' },
        },
        {
          id: 'persist-poem',
          type: 'tool',
          tool_id: WRITE_POEM_TOOL_ID,
          operation_id: 'update-document',
          input_mapping: { content: 'state.poem' },
        },
        {
          id: 'return-poem',
          type: 'transform',
          expression: { var: 'poem' },
        },
      ],
      edges: [
        { from: 'generate-title', to: 'generate-stanza-1' },
        { from: 'generate-stanza-1', to: 'generate-stanza-2' },
        { from: 'generate-stanza-2', to: 'generate-stanza-3' },
        { from: 'generate-stanza-3', to: 'generate-stanza-4' },
        { from: 'generate-stanza-4', to: 'assemble-poem' },
        { from: 'assemble-poem', to: 'persist-poem' },
        { from: 'assemble-poem', to: 'return-poem' },
      ],
    },
  });
const ORCHESTRATION_ID = orchestration.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CREATE_ORCHESTRATION_RESP=$(curl -s -X POST "$SOAT_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Direct Sonnet Orchestration\",\"description\":\"Direct agent-node sonnet pipeline\",\"nodes\":[{\"id\":\"generate-title\",\"type\":\"agent\",\"agent_id\":\"$TITLE_AGENT_ID\",\"input_mapping\":{\"theme\":\"state.theme\"},\"output_schema\":{\"type\":\"object\",\"required\":[\"title\"],\"properties\":{\"title\":{\"type\":\"string\"}}},\"output_mapping\":{\"title\":\"state.title\"}},{\"id\":\"generate-stanza-1\",\"type\":\"agent\",\"agent_id\":\"$STANZA1_AGENT_ID\",\"input_mapping\":{\"theme\":\"state.theme\",\"title\":\"state.title\"},\"output_schema\":{\"type\":\"object\",\"required\":[\"stanza\"],\"properties\":{\"stanza\":{\"type\":\"string\"}}},\"output_mapping\":{\"stanza\":\"state.stanza1\"}},{\"id\":\"generate-stanza-2\",\"type\":\"agent\",\"agent_id\":\"$STANZA2_AGENT_ID\",\"input_mapping\":{\"theme\":\"state.theme\",\"title\":\"state.title\",\"stanza1\":\"state.stanza1\"},\"output_schema\":{\"type\":\"object\",\"required\":[\"stanza\"],\"properties\":{\"stanza\":{\"type\":\"string\"}}},\"output_mapping\":{\"stanza\":\"state.stanza2\"}},{\"id\":\"generate-stanza-3\",\"type\":\"agent\",\"agent_id\":\"$STANZA3_AGENT_ID\",\"input_mapping\":{\"theme\":\"state.theme\",\"title\":\"state.title\",\"stanza1\":\"state.stanza1\",\"stanza2\":\"state.stanza2\"},\"output_schema\":{\"type\":\"object\",\"required\":[\"stanza\"],\"properties\":{\"stanza\":{\"type\":\"string\"}}},\"output_mapping\":{\"stanza\":\"state.stanza3\"}},{\"id\":\"generate-stanza-4\",\"type\":\"agent\",\"agent_id\":\"$STANZA4_AGENT_ID\",\"input_mapping\":{\"theme\":\"state.theme\",\"title\":\"state.title\",\"stanza1\":\"state.stanza1\",\"stanza2\":\"state.stanza2\",\"stanza3\":\"state.stanza3\"},\"output_schema\":{\"type\":\"object\",\"required\":[\"stanza\"],\"properties\":{\"stanza\":{\"type\":\"string\"}}},\"output_mapping\":{\"stanza\":\"state.stanza4\"}},{\"id\":\"assemble-poem\",\"type\":\"transform\",\"expression\":{\"cat\":[{\"var\":\"title\"},\"\\n\\n\",{\"var\":\"stanza1\"},\"\\n\\n\",{\"var\":\"stanza2\"},\"\\n\\n\",{\"var\":\"stanza3\"},\"\\n\\n\",{\"var\":\"stanza4\"}]},\"output_mapping\":{\"result\":\"state.poem\"}},{\"id\":\"persist-poem\",\"type\":\"tool\",\"tool_id\":\"$WRITE_POEM_TOOL_ID\",\"operation_id\":\"update-document\",\"input_mapping\":{\"content\":\"state.poem\"}},{\"id\":\"return-poem\",\"type\":\"transform\",\"expression\":{\"var\":\"poem\"}}],\"edges\":[{\"from\":\"generate-title\",\"to\":\"generate-stanza-1\"},{\"from\":\"generate-stanza-1\",\"to\":\"generate-stanza-2\"},{\"from\":\"generate-stanza-2\",\"to\":\"generate-stanza-3\"},{\"from\":\"generate-stanza-3\",\"to\":\"generate-stanza-4\"},{\"from\":\"generate-stanza-4\",\"to\":\"assemble-poem\"},{\"from\":\"assemble-poem\",\"to\":\"persist-poem\"},{\"from\":\"assemble-poem\",\"to\":\"return-poem\"}]}" )

ORCHESTRATION_ID=$(printf '%s\n' "$CREATE_ORCHESTRATION_RESP" | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Start a run

Run the [orchestration](/docs/modules/orchestrations#examples) with a theme. The run output includes both terminal nodes: the persisted document update and the returned poem text.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN=$(soat start-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"theme":"artificial intelligence"}')

printf '%s\n' "$RUN" | jq '{status, trace_id, output}'
RUN_ID=$(printf '%s\n' "$RUN" | jq -r '.id')

echo "\nFinal poem returned by the orchestration:\n"
printf '%s\n' "$RUN" | jq -r '.output["return-poem"].result'
echo "\nRUN_ID: $RUN_ID"
```

Expected status output:

```json
{
  "status": "completed",
  "trace_id": "agt_trace_example",
  "output": {
    "persist-poem": {
      "id": "doc_example"
    },
    "return-poem": {
      "result": "... poem text ..."
    }
  }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await adminSoat.orchestrations.startOrchestrationRun({
  path: { orchestration_id: ORCHESTRATION_ID },
  body: {
    input: { theme: 'artificial intelligence' },
  },
});

console.log('Status:', run.status);
console.log('Trace ID:', run.trace_id);
console.log('Final poem:\n', run.output?.['return-poem']?.result);
const RUN_ID = run.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN=$(curl -s -X POST "$SOAT_URL/api/v1/orchestrations/$ORCHESTRATION_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"theme":"artificial intelligence"}}')

printf '%s\n' "$RUN" | jq '{status, trace_id, output}'
RUN_ID=$(printf '%s\n' "$RUN" | jq -r '.id')
printf '%s\n' "$RUN" | jq -r '.output["return-poem"].result'
echo "RUN_ID: $RUN_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Read the persisted poem document

The [document](/docs/modules/documents#examples) now contains the final poem written by the `persist-poem` tool node.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-document --document-id "$POEM_DOC_ID" | jq -r '.content'
```

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

## Step 9 — Inspect the run state

Use `get-orchestration-run` to inspect the accumulated [orchestration](/docs/modules/orchestrations#examples) state. This is the main difference from the nested-agent tutorial: you can see every intermediate field directly in the run record.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --run-id "$RUN_ID" | jq '{status, state, output}'
```

Key fields to look for:

- `state.title`
- `state.stanza1` through `state.stanza4`
- `state.poem`
- `output["return-poem"].result`

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: runState } = await adminSoat.orchestrations.getOrchestrationRun({
  path: { orchestration_id: ORCHESTRATION_ID, run_id: RUN_ID },
});
console.log(JSON.stringify(runState.state, null, 2));
console.log(runState.output?.['return-poem']?.result);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/orchestrations/$ORCHESTRATION_ID/runs/$RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, state, output}'
```

</TabItem>
</Tabs>

---

## How It Works

- `agent` nodes call the five agents directly. No agent needs a tool that creates another agent generation.
- `output_mapping` writes each agent result into orchestration state under `state.title`, `state.stanza1`, and so on.
- The `transform` node assembles the poem deterministically with JSON Logic.
- The `tool` node persists the result to the shared document using a fixed `documentId`.
- The terminal `return-poem` node makes the final poem easy to read from the run output while the persisted document gives you durable storage.

Compared with [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration), this pattern moves routing, sequencing, and state accumulation into the [Orchestrations](/docs/modules/orchestrations#examples) engine instead of leaving them to an orchestrator agent.
