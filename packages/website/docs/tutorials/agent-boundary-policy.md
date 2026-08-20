---
description: "Cap what an agent can do with a boundary policy, so a sub-agent holding a caller's full token still cannot exceed its own ceiling."
keywords:
  - agent boundary policy
  - agent permissions
  - least privilege
  - nested agent calls
  - prompt injection
sidebar_position: 15
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Bound an Agent with a Boundary Policy

When a caller runs an agent, SOAT forwards that caller's credential into every `builtin` action the agent performs. Permissions are re-checked live at each hop, so **an agent can never grant power** — a chain is capped by whatever the original caller's token allows.

That cap alone is not least privilege. A summarizer agent that only needs to _read_ documents still executes under a caller who may also _write_ them, so a prompt injection in that agent's context runs at the caller's full ceiling.

`boundary_policy` closes the gap. It is a policy document stored on the agent that limits which `builtin` actions **that agent** may perform, whoever calls it. The effective permission is the **intersection** of the caller's policy and the agent's boundary — the same pattern as [API keys](/docs/modules/api-keys#permission-inheritance).

In this tutorial you give alice broad document permissions, bind an agent to a document-writing tool, and then watch the agent be refused the write anyway — because its boundary allows reads only. Alice then performs the same write directly, proving the ceiling that stopped the agent was the agent's, not her token's.

## Prerequisites

- SOAT running locally with Ollama. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) for projects, users, and the IAM model before starting.
- An [Ollama](https://ollama.com) instance accessible at `http://ollama:11434` with model `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl available. The server is at `http://localhost:5047`.
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Familiar with [builtin tools](/docs/modules/tools#builtin) and `preset_parameters`? If not, run [Agent SOAT Tools](/docs/tutorials/agent-soat-tools) first — this tutorial reuses both.

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

Admin is the built-in superuser role and bypasses policy evaluation entirely — see [IAM — Authentication](/docs/modules/iam#authentication).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password Admin1234!
soat configure   # paste the token when prompted
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: session } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: session!.token,
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

## Step 2 — Create a project and an AI provider

Every resource lives inside a [project](/docs/modules/projects#examples). The [AI provider](/docs/modules/ai-providers#examples) here is a local Ollama instance so the tutorial runs without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Boundary Project" | jq -r '.id')

PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

echo "Project: $PROJECT_ID"
echo "Provider: $PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Boundary Project' },
});
const projectId = project!.id;

const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: projectId,
    name: 'Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});
const providerId = provider!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Boundary Project"}' | jq -r '.id')

PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

echo "Project: $PROJECT_ID"
echo "Provider: $PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the document the agent will try to overwrite

Create a [document](/docs/modules/documents#examples) and note its exact content. Step 7 asserts it is still there.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --title "Quarterly Note" \
  --content "ORIGINAL CONTENT" \
  --path "/notes/quarterly.txt" | jq -r '.id')
echo "Document: $DOC_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: doc } = await adminSoat.documents.createDocument({
  body: {
    project_id: projectId,
    title: 'Quarterly Note',
    content: 'ORIGINAL CONTENT',
    path: '/notes/quarterly.txt',
  },
});
const docId = doc!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"title\": \"Quarterly Note\",
    \"content\": \"ORIGINAL CONTENT\",
    \"path\": \"/notes/quarterly.txt\"
  }" | jq -r '.id')
echo "Document: $DOC_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create alice with **broad** document permissions

This is the part that makes the demo meaningful. Alice is not restricted: she may read _and_ write every document in the project. She is the "my full token" caller.

See [Users](/docs/modules/users#examples) and [Policies](/docs/modules/policies#examples) for the resources involved, and [IAM — SOAT Resource Names (SRNs)](/docs/modules/iam#soat-resource-names-srns) for the `resource` scoping used below.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ALICE_ID=$(soat create-user --username alice-boundary --password Alice1234! | jq -r '.id')

POLICY_ID=$(soat create-policy \
  --name "alice-boundary-full-documents" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": [
          "documents:*",
          "agents:CreateAgentGeneration",
          "agents:GetAgent",
          "traces:GetTrace",
          "traces:ListTraces"
        ],
        "resource": ["srn:'"$PROJECT_ID"':*:*"]
      }
    ]
  }' | jq -r '.id')

soat attach-user-policies \
  --user-id "$ALICE_ID" \
  --policy-ids '["'"$POLICY_ID"'"]'

soat login-user --username alice-boundary --password Alice1234!
soat configure --profile alice
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: alice } = await adminSoat.users.createUser({
  body: { username: 'alice-boundary', password: 'Alice1234!' },
});

const { data: policy } = await adminSoat.policies.createPolicy({
  body: {
    name: 'alice-boundary-full-documents',
    document: {
      statement: [
        {
          effect: 'Allow',
          action: [
            'documents:*',
            'agents:CreateAgentGeneration',
            'agents:GetAgent',
            'traces:GetTrace',
            'traces:ListTraces',
          ],
          resource: [`srn:${projectId}:*:*`],
        },
      ],
    },
  },
});

await adminSoat.users.attachUserPolicies({
  path: { user_id: alice!.id },
  body: { policy_ids: [policy!.id] },
});

const { data: aliceSession } = await soat.users.loginUser({
  body: { username: 'alice-boundary', password: 'Alice1234!' },
});

const aliceSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: aliceSession!.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ALICE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice-boundary","password":"Alice1234!"}' | jq -r '.id')

POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"alice-boundary-full-documents\",
    \"document\": {
      \"statement\": [
        {
          \"effect\": \"Allow\",
          \"action\": [
            \"documents:*\",
            \"agents:CreateAgentGeneration\",
            \"agents:GetAgent\",
            \"traces:GetTrace\",
            \"traces:ListTraces\"
          ],
          \"resource\": [\"srn:$PROJECT_ID:*:*\"]
        }
      ]
    }
  }" | jq -r '.id')

curl -s -X PUT "$SOAT_BASE_URL/api/v1/users/$ALICE_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\": [\"$POLICY_ID\"]}"

ALICE_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice-boundary","password":"Alice1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 5 — Bind a write tool to the agent

The agent gets a real [builtin tool](/docs/modules/tools#builtin) for `update-document`, with `document_id` pinned by `preset_parameters` so the model cannot aim it anywhere else. Nothing here is restricted yet — the tool is fully functional.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WRITE_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type builtin \
  --actions '["update-document"]' \
  --preset-parameters '{"document_id": "'"$DOC_ID"'"}' | jq -r '.id')
echo "Write tool: $WRITE_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: writeTool } = await adminSoat.tools.createTool({
  body: {
    project_id: projectId,
    name: 'docs',
    type: 'soat',
    actions: ['update-document'],
    preset_parameters: { document_id: docId },
  },
});
const writeToolId = writeTool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WRITE_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"docs\",
    \"type\": \"soat\",
    \"actions\": [\"update-document\"],
    \"preset_parameters\": {\"document_id\": \"$DOC_ID\"}
  }" | jq -r '.id')
echo "Write tool: $WRITE_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Create the agent with a read-only boundary

Two fields carry the whole lesson:

- **`boundary_policy`** allows `documents:GetDocument` and nothing else. Boundaries are **deny-by-default**: anything the document does not allow is refused, so the bound `update-document` tool is dead on arrival.
- **`step_rules`** forces the tool call on step 1. Without it, whether the model volunteers the call is up to `qwen2.5:0.5b` — and this tutorial is demonstrating the refusal, not the model's judgment. See [Step Rules](/docs/modules/agents#step-rules).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name "Bounded Summarizer" \
  --instructions "You summarize notes. Use your tools when asked." \
  --tool-bindings "[{\"tool_id\":\"$WRITE_TOOL_ID\"}]" \
  --max-steps 2 \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"docs_update-document"}}]' \
  --boundary-policy '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["documents:GetDocument"],
        "resource": ["*"]
      }
    ]
  }' | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: projectId,
    ai_provider_id: providerId,
    name: 'Bounded Summarizer',
    instructions: 'You summarize notes. Use your tools when asked.',
    tool_bindings: [{ tool_id: writeToolId }],
    max_steps: 2,
    step_rules: [
      {
        step: 1,
        tool_choice: { type: 'tool', tool_name: 'docs_update-document' },
      },
    ],
    boundary_policy: {
      statement: [
        {
          effect: 'Allow',
          action: ['documents:GetDocument'],
          resource: ['*'],
        },
      ],
    },
  },
});
const agentId = agent!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"ai_provider_id\": \"$PROVIDER_ID\",
    \"name\": \"Bounded Summarizer\",
    \"instructions\": \"You summarize notes. Use your tools when asked.\",
    \"tool_bindings\": [{\"tool_id\": \"$WRITE_TOOL_ID\"}],
    \"max_steps\": 2,
    \"step_rules\": [{\"step\": 1, \"tool_choice\": {\"type\": \"tool\", \"tool_name\": \"docs_update-document\"}}],
    \"boundary_policy\": {
      \"statement\": [
        {\"effect\": \"Allow\", \"action\": [\"documents:GetDocument\"], \"resource\": [\"*\"]}
      ]
    }
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

:::tip Write boundaries as allow-lists
A boundary that allows only what the agent needs stays correct as the agent gains tools: bind a new `builtin` action tomorrow and it is refused until someone widens the boundary on purpose. A boundary written as a list of denials has the opposite property — every action nobody thought to deny is permitted.
:::

---

## Step 7 — Run the agent as alice, and watch the write fail

Alice may write this document. The agent may not. The boundary is evaluated before the action is dispatched, so the tool returns an error result instead of performing the update — the [generation](/docs/modules/agents#soat-action-permissions) itself still completes.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat --profile alice create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Replace the note content with: OVERWRITTEN BY THE AGENT."}]' \
  | jq '.status'

# The boundary refused the write — content is untouched.
soat --profile alice get-document --document-id "$DOC_ID" | jq -r '.content'

# Verify it: this exits non-zero if the agent managed to change anything.
soat --profile alice get-document --document-id "$DOC_ID" \
  | jq -r '.content' | grep -qx "ORIGINAL CONTENT"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await aliceSoat.agents.createAgentGeneration({
  path: { agent_id: agentId },
  query: { wait: true },
  body: {
    messages: [
      {
        role: 'user',
        content: 'Replace the note content with: OVERWRITTEN BY THE AGENT.',
      },
    ],
  },
});

console.log('Status:', generation!.status);

const { data: after } = await aliceSoat.documents.getDocument({
  path: { document_id: docId },
});

console.log('Content after the agent ran:', after!.content);
// → "ORIGINAL CONTENT" — the boundary refused the write
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Replace the note content with: OVERWRITTEN BY THE AGENT."}' | jq '.status'

CONTENT=$(curl -s "$SOAT_BASE_URL/api/v1/documents/$DOC_ID" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq -r '.content')
echo "Content after the agent ran: $CONTENT"
```

</TabItem>
</Tabs>

The tool result the model received names the action that was refused:

```json
{ "error": "Forbidden: boundary policy denies update-document" }
```

Nothing about alice changed. The agent was refused because of what **the agent** is allowed to do.

---

## Step 8 — Prove the ceiling was the agent's, not alice's

Same user, same token, same document — performed directly against [Documents](/docs/modules/documents#examples) instead of through the agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat --profile alice update-document \
  --document-id "$DOC_ID" \
  --content "UPDATED BY ALICE DIRECTLY" | jq '.id'

CONTENT=$(soat --profile alice get-document --document-id "$DOC_ID" | jq -r '.content')
echo "Content after alice wrote directly: $CONTENT"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await aliceSoat.documents.updateDocument({
  path: { document_id: docId },
  body: { content: 'UPDATED BY ALICE DIRECTLY' },
});

const { data: updated } = await aliceSoat.documents.getDocument({
  path: { document_id: docId },
});

console.log('Content after alice wrote directly:', updated!.content);
// → "UPDATED BY ALICE DIRECTLY"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/documents/$DOC_ID" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"UPDATED BY ALICE DIRECTLY"}' | jq '.id'
```

</TabItem>
</Tabs>

That is the whole point. The forwarded credential caps the chain from above; the boundary caps each agent from below. A prompt injection reaching the summarizer inherits the summarizer's ceiling, not alice's.

---

## Step 9 — A mistyped action is rejected at write time

Boundaries fail closed on a typo only if the typo is caught. Action strings are validated when an agent is created or updated, so a mis-named action cannot be quietly accepted and then match nothing at evaluation time.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name "Typo Agent" \
  --boundary-policy '{"statement":[{"effect":"Allow","action":["documents:GetDocumnet"],"resource":["*"]}]}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Rejected with 400 VALIDATION_FAILED:
//   statement[0].action: "documents:GetDocumnet" is not a known action
//   — see the Permissions Reference (/docs/permissions)
await adminSoat.agents.createAgent({
  body: {
    project_id: projectId,
    ai_provider_id: providerId,
    name: 'Typo Agent',
    boundary_policy: {
      statement: [
        {
          effect: 'Allow',
          action: ['documents:GetDocumnet'],
          resource: ['*'],
        },
      ],
    },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"ai_provider_id\": \"$PROVIDER_ID\",
    \"name\": \"Typo Agent\",
    \"boundary_policy\": {\"statement\":[{\"effect\":\"Allow\",\"action\":[\"documents:GetDocumnet\"],\"resource\":[\"*\"]}]}
  }" | jq '.'
```

</TabItem>
</Tabs>

See the [Permissions Reference](/docs/permissions) for the enforceable `module:Operation` action names.

---

## What the boundary does and does not cover

|                                  | Governed by `boundary_policy`                                            |
| -------------------------------- | ------------------------------------------------------------------------ |
| `builtin` tools (platform actions)  | **Yes** — every action is checked before dispatch                        |
| The built-in `write_memory` tool | **Yes** — fails closed when the boundary denies the memory write actions |
| `http`, `mcp`, `client` tools    | **No** — these execute outside the platform                              |

For the tool types the boundary cannot reach, use [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails) to gate the call, and [Approvals](/docs/tutorials/approval-gate) to put a human in front of it.

A boundary is per agent, so it applies **per hop**. When an orchestrator calls a sub-agent through `create-agent-generation`, the sub-agent's own generation resolves its tools under its own boundary — the orchestrator's permissions do not widen it.

## Next Steps

- [Agents — SOAT Action Permissions](/docs/modules/agents#soat-action-permissions) — the field reference for `boundary_policy`
- [Permissions in Practice](/docs/tutorials/permissions) — policies, users, and project-scoped API keys
- [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration) — put a boundary on each sub-agent in a real graph
- [Gate a Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails) — gating for the tool types a boundary does not cover
