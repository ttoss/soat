---
sidebar_position: 4
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Multi-Agent Orchestration

This tutorial demonstrates how to build a **multi-agent orchestration** pipeline where one agent coordinates multiple sub-agents using [SOAT tools](/docs/modules/agents#soat). This pattern applies to any workflow that can be decomposed into sequential or parallel sub-tasks — content pipelines, data processing, multi-step analysis, code generation, report assembly, and more.

As a concrete example, you will build a system that composes a sonnet: an orchestrator agent creates the poem title itself and then delegates each stanza to a specialized sub-agent, all collaborating through a shared document. The same architecture works for any scenario where:

1. A **coordinator agent** receives a request, performs initial work, and breaks the rest into sub-tasks.
2. **Worker agents** each have tools to read shared state and write their results.
3. The coordinator calls workers in sequence (or in parallel), accumulating results.
4. A [trace](/docs/modules/agents#traces) captures the full execution tree for observability.

By the end you will understand:

- How to wire agent-to-agent calls via SOAT tools (the orchestration primitive)
- How tool calls are resolved and executed server-side without client round-trips
- How traces provide end-to-end observability across nested agent calls
- How documents serve as shared state between agents in a pipeline

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and sessions before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
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

Admin is the built-in superuser role. See [Users](/docs/modules/users) for full authentication details.

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
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Every resource lives inside a [project](/docs/modules/projects). Create one for this tutorial.

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
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sonnet Workshop"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an AI provider

Set up a local [AI provider](/docs/modules/ai-providers) backed by Ollama. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen3.5:0.8b" | jq -r '.id')
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
    default_model: 'qwen3.5:0.8b',
  },
});
const AI_PROVIDER_ID = aiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen3.5:0.8b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create a shared document for the poem

Create a [document](/docs/modules/documents) that will hold the poem. Each stanza agent will read this document, then update it by appending their stanza.

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
POEM_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"content\":\"(empty - will be overwritten by stanza agents)\",\"path\":\"/poems/sonnet.txt\"}" \
  | jq -r '.id')
echo "POEM_DOC_ID: $POEM_DOC_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create SOAT tools for stanza agents

Each stanza agent needs two [SOAT tools](/docs/modules/agents#soat):

1. **read-poem** — reads the current poem document (`get-document` action)
2. **write-stanza** — updates the poem document with the new stanza (`update-document` action)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
READ_POEM_TOOL_ID=$(soat create-agent-tool \
  --project-id "$PROJECT_ID" \
  --name "read-poem" \
  --type "soat" \
  --description "Read the current state of the poem document" \
  --actions '["get-document"]' | jq -r '.id')
echo "READ_POEM_TOOL_ID: $READ_POEM_TOOL_ID"

WRITE_STANZA_TOOL_ID=$(soat create-agent-tool \
  --project-id "$PROJECT_ID" \
  --name "write-stanza" \
  --type "soat" \
  --description "Update the poem document with new content" \
  --actions '["update-document"]' | jq -r '.id')
echo "WRITE_STANZA_TOOL_ID: $WRITE_STANZA_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: readPoemTool } = await adminSoat.agentTools.createAgentTool({
  body: {
    project_id: PROJECT_ID,
    name: 'read-poem',
    type: 'soat',
    description: 'Read the current state of the poem document',
    actions: ['get-document'],
  },
});
const READ_POEM_TOOL_ID = readPoemTool.id;

const { data: writeStanzaTool } = await adminSoat.agentTools.createAgentTool({
  body: {
    project_id: PROJECT_ID,
    name: 'write-stanza',
    type: 'soat',
    description: 'Update the poem document with new content',
    actions: ['update-document'],
  },
});
const WRITE_STANZA_TOOL_ID = writeStanzaTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
READ_POEM_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agent-tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"read-poem\",\"type\":\"soat\",\"description\":\"Read the current state of the poem document\",\"actions\":[\"get-document\"]}" \
  | jq -r '.id')
echo "READ_POEM_TOOL_ID: $READ_POEM_TOOL_ID"

WRITE_STANZA_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agent-tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"write-stanza\",\"type\":\"soat\",\"description\":\"Update the poem document with new content\",\"actions\":[\"update-document\"]}" \
  | jq -r '.id')
echo "WRITE_STANZA_TOOL_ID: $WRITE_STANZA_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Create the orchestrator's SOAT tool

The orchestrator [agent](/docs/modules/agents) needs a SOAT tool that allows it to call other agents. The `create-agent-generation` action lets it trigger generation on any agent in the project.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCHESTRATOR_TOOL_ID=$(soat create-agent-tool \
  --project-id "$PROJECT_ID" \
  --name "call-agent" \
  --type "soat" \
  --description "Call another agent to generate a response" \
  --actions '["create-agent-generation"]' | jq -r '.id')
echo "ORCHESTRATOR_TOOL_ID: $ORCHESTRATOR_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestratorTool } = await adminSoat.agentTools.createAgentTool({
  body: {
    project_id: PROJECT_ID,
    name: 'call-agent',
    type: 'soat',
    description: 'Call another agent to generate a response',
    actions: ['create-agent-generation'],
  },
});
const ORCHESTRATOR_TOOL_ID = orchestratorTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCHESTRATOR_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agent-tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"call-agent\",\"type\":\"soat\",\"description\":\"Call another agent to generate a response\",\"actions\":[\"create-agent-generation\"]}" \
  | jq -r '.id')
echo "ORCHESTRATOR_TOOL_ID: $ORCHESTRATOR_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Create the four stanza agents

Each stanza agent is responsible for writing one stanza of the sonnet. They share the same tools (read-poem, write-stanza) but have different instructions. A sonnet has 4 stanzas: two quatrains (4 lines each), one quatrain, and a final couplet (2 lines). See [Agents](/docs/modules/agents) for all configuration options.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STANZA1_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 1 - First Quatrain" \
  --instructions "You are a poet writing the FIRST quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to see what has been written so far (document ID: $POEM_DOC_ID). Then compose your 4 lines and use the write-stanza tool to update the document with your stanza. Use ABAB rhyme scheme. The content you write should be the complete document so far plus your new stanza." \
  --tool-ids "[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"]" \
  --max-steps 5 | jq -r '.id')
echo "STANZA1_AGENT_ID: $STANZA1_AGENT_ID"

STANZA2_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 2 - Second Quatrain" \
  --instructions "You are a poet writing the SECOND quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to read the poem so far (document ID: $POEM_DOC_ID). Then compose your 4 lines continuing the poem. Use CDCD rhyme scheme. Use the write-stanza tool to update the document with the full poem including your new stanza." \
  --tool-ids "[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"]" \
  --max-steps 5 | jq -r '.id')
echo "STANZA2_AGENT_ID: $STANZA2_AGENT_ID"

STANZA3_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 3 - Third Quatrain" \
  --instructions "You are a poet writing the THIRD quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to read the poem so far (document ID: $POEM_DOC_ID). Then compose your 4 lines continuing the poem. Use EFEF rhyme scheme. Use the write-stanza tool to update the document with the full poem including your new stanza." \
  --tool-ids "[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"]" \
  --max-steps 5 | jq -r '.id')
echo "STANZA3_AGENT_ID: $STANZA3_AGENT_ID"

STANZA4_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Stanza 4 - Final Couplet" \
  --instructions "You are a poet writing the FINAL couplet (2 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to read the poem so far (document ID: $POEM_DOC_ID). Then compose your concluding 2 lines that tie the poem together. Use GG rhyme scheme. Use the write-stanza tool to update the document with the full poem including your couplet." \
  --tool-ids "[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"]" \
  --max-steps 5 | jq -r '.id')
echo "STANZA4_AGENT_ID: $STANZA4_AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const stanzaConfigs = [
  {
    name: 'Stanza 1 - First Quatrain',
    instructions: `You are a poet writing the FIRST quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to see what has been written so far (document ID: ${POEM_DOC_ID}). Then compose your 4 lines and use the write-stanza tool to update the document with your stanza. Use ABAB rhyme scheme. The content you write should be the complete document so far plus your new stanza.`,
  },
  {
    name: 'Stanza 2 - Second Quatrain',
    instructions: `You are a poet writing the SECOND quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to read the poem so far (document ID: ${POEM_DOC_ID}). Then compose your 4 lines continuing the poem. Use CDCD rhyme scheme. Use the write-stanza tool to update the document with the full poem including your new stanza.`,
  },
  {
    name: 'Stanza 3 - Third Quatrain',
    instructions: `You are a poet writing the THIRD quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to read the poem so far (document ID: ${POEM_DOC_ID}). Then compose your 4 lines continuing the poem. Use EFEF rhyme scheme. Use the write-stanza tool to update the document with the full poem including your new stanza.`,
  },
  {
    name: 'Stanza 4 - Final Couplet',
    instructions: `You are a poet writing the FINAL couplet (2 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to read the poem so far (document ID: ${POEM_DOC_ID}). Then compose your concluding 2 lines that tie the poem together. Use GG rhyme scheme. Use the write-stanza tool to update the document with the full poem including your couplet.`,
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
      tool_ids: [READ_POEM_TOOL_ID, WRITE_STANZA_TOOL_ID],
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
STANZA1_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 1 - First Quatrain\",\"instructions\":\"You are a poet writing the FIRST quatrain (4 lines) of a sonnet. You will be given a theme. First, use the read-poem tool to see what has been written so far (document ID: $POEM_DOC_ID). Then compose your 4 lines and use the write-stanza tool to update the document. Use ABAB rhyme scheme.\",\"tool_ids\":[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA1_AGENT_ID: $STANZA1_AGENT_ID"

STANZA2_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 2 - Second Quatrain\",\"instructions\":\"You are a poet writing the SECOND quatrain (4 lines) of a sonnet. First, use the read-poem tool to read the poem so far (document ID: $POEM_DOC_ID). Then compose 4 lines. Use CDCD rhyme scheme. Write the full poem including your stanza.\",\"tool_ids\":[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA2_AGENT_ID: $STANZA2_AGENT_ID"

STANZA3_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 3 - Third Quatrain\",\"instructions\":\"You are a poet writing the THIRD quatrain (4 lines) of a sonnet. First, use the read-poem tool to read the poem so far (document ID: $POEM_DOC_ID). Then compose 4 lines. Use EFEF rhyme scheme. Write the full poem including your stanza.\",\"tool_ids\":[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA3_AGENT_ID: $STANZA3_AGENT_ID"

STANZA4_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Stanza 4 - Final Couplet\",\"instructions\":\"You are a poet writing the FINAL couplet (2 lines) of a sonnet. First, use the read-poem tool to read the poem so far (document ID: $POEM_DOC_ID). Then compose 2 concluding lines. Use GG rhyme scheme. Write the full poem including your couplet.\",\"tool_ids\":[\"$READ_POEM_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"],\"max_steps\":5}" \
  | jq -r '.id')
echo "STANZA4_AGENT_ID: $STANZA4_AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Create the orchestrator agent

The orchestrator agent has both the `call-agent` and `write-stanza` tools. It is responsible for creating the poem title (writing it directly to the shared document) and then calling each stanza agent in sequence to compose the body. See [Agents — Nested Agent Calls](/docs/modules/agents#nested-agent-calls) for how `max_call_depth` and `trace_id` propagation work.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCHESTRATOR_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Sonnet Orchestrator" \
  --instructions "You are a sonnet orchestrator. First, create a title for the sonnet and write it to the document (document ID: $POEM_DOC_ID) using the write-stanza tool. Then call four stanza agents in sequence to compose the body. Call them in order: 1) Agent $STANZA1_AGENT_ID (first quatrain, ABAB), 2) Agent $STANZA2_AGENT_ID (second quatrain, CDCD), 3) Agent $STANZA3_AGENT_ID (third quatrain, EFEF), 4) Agent $STANZA4_AGENT_ID (final couplet, GG). Pass the theme as user message for each call. Report completion when done." \
  --tool-ids "[\"$ORCHESTRATOR_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"write-stanza_update-document"}},{"step":2,"tool_choice":{"type":"tool","tool_name":"call-agent_create-agent-generation"}},{"step":3,"tool_choice":{"type":"tool","tool_name":"call-agent_create-agent-generation"}},{"step":4,"tool_choice":{"type":"tool","tool_name":"call-agent_create-agent-generation"}},{"step":5,"tool_choice":{"type":"tool","tool_name":"call-agent_create-agent-generation"}}]' \
  --max-steps 10 | jq -r '.id')
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
    instructions: `You are a sonnet orchestrator. First, create a title for the sonnet and write it to the document (document ID: ${POEM_DOC_ID}) using the write-stanza tool. Then call four stanza agents in sequence to compose the body.

Call the agents in this exact order using the call-agent tool:
1. Agent ${STANZA1_AGENT_ID} - writes the first quatrain (4 lines, ABAB)
2. Agent ${STANZA2_AGENT_ID} - writes the second quatrain (4 lines, CDCD)
3. Agent ${STANZA3_AGENT_ID} - writes the third quatrain (4 lines, EFEF)
4. Agent ${STANZA4_AGENT_ID} - writes the final couplet (2 lines, GG)

For each call, pass the theme as the user message. After all four agents have completed, report that the sonnet is complete.`,
    tool_ids: [ORCHESTRATOR_TOOL_ID, WRITE_STANZA_TOOL_ID],
    step_rules: [
      {
        step: 1,
        tool_choice: {
          type: 'tool',
          tool_name: 'write-stanza_update-document',
        },
      },
      {
        step: 2,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-agent_create-agent-generation',
        },
      },
      {
        step: 3,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-agent_create-agent-generation',
        },
      },
      {
        step: 4,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-agent_create-agent-generation',
        },
      },
      {
        step: 5,
        tool_choice: {
          type: 'tool',
          tool_name: 'call-agent_create-agent-generation',
        },
      },
    ],
    max_steps: 10,
  },
});
const ORCHESTRATOR_ID = orchestrator.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCHESTRATOR_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Sonnet Orchestrator\",\"instructions\":\"You are a sonnet orchestrator. First, create a title for the sonnet and write it to the document using the write-stanza tool. Then call four stanza agents in order: 1) $STANZA1_AGENT_ID (first quatrain), 2) $STANZA2_AGENT_ID (second quatrain), 3) $STANZA3_AGENT_ID (third quatrain), 4) $STANZA4_AGENT_ID (final couplet). Pass the theme as the user message for each call. Report completion when all four are done.\",\"tool_ids\":[\"$ORCHESTRATOR_TOOL_ID\",\"$WRITE_STANZA_TOOL_ID\"],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"write-stanza_update-document\"}},{\"step\":2,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-agent_create-agent-generation\"}},{\"step\":3,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-agent_create-agent-generation\"}},{\"step\":4,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-agent_create-agent-generation\"}},{\"step\":5,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"call-agent_create-agent-generation\"}}],\"max_steps\":10}" \
  | jq -r '.id')
echo "ORCHESTRATOR_ID: $ORCHESTRATOR_ID"
```

</TabItem>
</Tabs>

---

## Step 9 — Run the orchestrator

Now trigger the orchestrator with the theme "artificial intelligence". The orchestrator will call each stanza agent, which will use their SOAT tools to read and write the shared document. See [Agents — Generation](/docs/modules/agents#generation) for the generation lifecycle.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RESULT=$(soat create-agent-generation \
  --agent-id "$ORCHESTRATOR_ID" \
  --messages '[{"role":"user","content":"Write a sonnet about the theme: artificial intelligence"}]')
echo "$RESULT" | jq '{status, trace_id}'
TRACE_ID=$(echo "$RESULT" | jq -r '.trace_id')
echo "TRACE_ID: $TRACE_ID"
```

Expected output:

```json
{
  "status": "completed",
  "trace_id": "agt_trace_..."
}
```

The generation runs synchronously. The orchestrator calls each stanza agent in sequence, each of which reads the poem, writes its stanza, and returns. The entire chain completes in a single request.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: result } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: ORCHESTRATOR_ID },
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
const TRACE_ID = result.trace_id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RESULT=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$ORCHESTRATOR_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a sonnet about the theme: artificial intelligence"}]}')
echo "$RESULT" | jq '{status, trace_id}'
TRACE_ID=$(echo "$RESULT" | jq -r '.trace_id')
echo "TRACE_ID: $TRACE_ID"
```

</TabItem>
</Tabs>

---

## Step 10 — Read the completed poem

The four stanza agents have each written their part to the shared [document](/docs/modules/documents). Retrieve it to see the full sonnet.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-document --document-id "$POEM_DOC_ID" | jq -r '.content'
```

Example output:

```
Silicon Dreams

In circuits deep where silicon dreams reside,
A spark of thought ignites the digital night,
Through neural paths where logic flows with pride,
Artificial minds awaken to the light.

With algorithms weaving through the void,
They learn from patterns humans cannot see,
Each calculation carefully employed,
To mirror thought in pure machinery.

Yet still they lack the warmth of human heart,
The tender touch of empathy and grace,
Though brilliant in their computational art,
They seek to find a more authentic place.

But in this dance of code and consciousness,
Lies hope for a shared path to luminousness.
```

Notice how the orchestrator created the title "Silicon Dreams" and the four stanza agents each contributed their stanza below it.

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
curl -s "$SOAT_BASE_URL/api/v1/documents/$POEM_DOC_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.content'
```

</TabItem>
</Tabs>

---

## Step 11 — Inspect the trace

The [trace](/docs/modules/agents#traces) captures the entire execution tree — the orchestrator's reasoning, each tool call to stanza agents, and each stanza agent's tool calls to read/write the document. This gives you full observability into multi-agent orchestration.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-agent-trace --trace-id "$TRACE_ID" | jq '.'
```

The trace shows the complete execution graph:

```json
{
  "id": "agt_trace_...",
  "project_id": "proj_...",
  "agent_id": "agt_...",
  "step_count": 15,
  "steps": [
    {
      "type": "model_call",
      "agent": "Sonnet Orchestrator",
      "tool_calls": [
        {
          "name": "write-stanza_update-document",
          "arguments": { "documentId": "doc_...", "content": "Silicon Dreams\n\n" }
        }
      ]
    },
    {
      "type": "model_call",
      "agent": "Sonnet Orchestrator",
      "tool_calls": [
        {
          "name": "call-agent_create-agent-generation",
          "arguments": { "agentId": "agt_...", "messages": [...] }
        }
      ]
    },
    {
      "type": "tool_result",
      "name": "call-agent_create-agent-generation",
      "nested_trace": {
        "agent": "Stanza 1 - First Quatrain",
        "tool_calls": [
          { "name": "read-poem_get-document", "arguments": { "documentId": "doc_..." } },
          { "name": "write-stanza_update-document", "arguments": { "documentId": "doc_...", "content": "..." } }
        ]
      }
    }
  ]
}
```

Key observations:

- The **first tool call** is the orchestrator writing the poem title directly — the coordinator performs work itself, not just delegation.
- Each subsequent orchestrator tool call spawns a **nested trace** for a stanza agent.
- Each stanza agent's trace shows its `read-poem` and `write-stanza` tool calls.
- **`step_count`** shows the total number of reasoning steps across all nested agents.
- The `trace_id` is shared across the entire call tree, making it easy to reconstruct the full execution path.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: trace } = await adminSoat.agentTraces.getAgentTrace({
  path: { trace_id: TRACE_ID },
});
console.log(JSON.stringify(trace, null, 2));
console.log('Total steps:', trace.step_count);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/agents/traces/$TRACE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

</TabItem>
</Tabs>

---

## Step 12 — List all traces for the project

You can also list all traces in the project to see both the orchestrator's trace and any individual stanza agent traces. See [Agents — Traces](/docs/modules/agents#traces) for filtering and pagination options.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-agent-traces --project-id "$PROJECT_ID" | jq '.data[] | {id, agent_id, step_count}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: traces } = await adminSoat.agentTraces.listAgentTraces({
  query: { project_id: PROJECT_ID },
});
for (const t of traces.data ?? []) {
  console.log(`Trace ${t.id} | Agent: ${t.agent_id} | Steps: ${t.step_count}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/agents/traces?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[] | {id, agent_id, step_count}'
```

</TabItem>
</Tabs>

---

## How It Works — The Orchestration Pattern

The architecture you built follows a general **coordinator → workers → shared state** pattern:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Coordinator Agent                               │
│  Tools: call-agent, write-stanza                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  0. Write poem title directly ──► shared state                      │
│  1. Call Worker Agent 1 ──► reads state ──► writes result 1         │
│  2. Call Worker Agent 2 ──► reads state ──► writes result 2         │
│  3. Call Worker Agent 3 ──► reads state ──► writes result 3         │
│  4. Call Worker Agent 4 ──► reads state ──► writes result 4         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────┐
                 │  Shared State          │
                 │  (Document, File, DB)  │
                 │                        │
                 │  (accumulates results) │
                 └────────────────────────┘
```

The trace captures this entire flow:

1. **Coordinator** writes the title directly using its `write-stanza` tool — demonstrating that a coordinator can perform work itself, not only delegate.
2. **Coordinator** makes N sequential `call-agent_create-agent-generation` tool calls.
3. Each **worker agent** uses its tools to read current state and write its contribution.
4. All nested agent executions share the same `trace_id`, creating a unified execution tree.
5. Each worker's result returns to the coordinator, which proceeds to call the next.

This pattern is not limited to creative writing. You can apply it to:

- **Data pipelines** — each worker agent processes one stage (extract, transform, validate, load)
- **Report generation** — workers gather data from different sources; coordinator assembles the final report
- **Code generation** — workers handle different modules; coordinator integrates and validates
- **Multi-step analysis** — workers perform independent analyses; coordinator synthesizes conclusions

---

## Summary

In this tutorial you learned how to:

| Concept                    | What you did                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Agent-to-agent calls       | Used a SOAT tool with `create-agent-generation` action to let a coordinator call worker agents   |
| SOAT tools                 | Created tools with `get-document` and `update-document` actions for reading/writing shared state |
| Shared state via documents | Used a single document as a coordination mechanism between agents                                |
| Traces                     | Inspected the full execution tree showing all nested agent calls and tool invocations            |
| Orchestration pattern      | Built a multi-agent pipeline where a coordinator delegates to specialized workers                |
