---
description: "Cap what an agent can do with its policy_ids, so a sub-agent holding a caller's full token still cannot exceed its own ceiling."
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

# Bound an Agent with Its Policies

SOAT forwards the caller's credential into every `builtin` action an agent performs, so a chain is capped by the caller's token. That cap is not least privilege: a read-only summarizer running under a caller who may write documents executes at the caller's ceiling.

An agent's `policy_ids` name stored policies that limit which `builtin` actions that agent may perform, whoever calls it. Every generation runs as the caller ∩ those policies, as with [API keys](/docs/modules/api-keys#permission-inheritance).

You give alice broad document permissions, bind an agent to a document-writing tool, watch the agent's write be refused by a read-only policy, then perform the same write directly as alice.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [Ollama](https://ollama.com) at `http://ollama:11434` with `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl; server at `http://localhost:5047`.
- [Builtin tools](/docs/modules/tools#builtin) and `preset_parameters` — see [Agent SOAT Tools](/docs/tutorials/agent-soat-tools).

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

Admin bypasses policy evaluation — see [IAM — Authentication](/docs/modules/iam#authentication).

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

A [project](/docs/modules/projects#examples) and a local Ollama [AI provider](/docs/modules/ai-providers#examples). For other providers see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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

Create a [document](/docs/modules/documents#examples); Step 7 asserts its content is unchanged.

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

Alice may read and write every document in the project. See [Users](/docs/modules/users#examples), [Policies](/docs/modules/policies#examples) and [SRNs](/docs/modules/iam#soat-resource-names-srns) for the `resource` scoping.

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
          "agents:UpdateAgent",
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
            'agents:UpdateAgent',
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
            \"agents:UpdateAgent\",
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

A [builtin tool](/docs/modules/tools#builtin) for `update-document`, with `document_id` pinned by `preset_parameters`. The tool itself is unrestricted.

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

## Step 6 — Create the agent with a read-only policy

- The agent's policy allows `documents:GetDocument` only. Policies are deny-by-default, so the bound `update-document` tool is refused.
- Attaching it needs a caller who holds every grant it carries; admin does.
- `step_rules` forces the tool call on step 1 so the refusal does not depend on `qwen2.5:0.5b` volunteering it. See [Step Rules](/docs/modules/agents#step-rules).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
READ_POLICY_ID=$(soat create-policy \
  --name "summarizer-read-only" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["documents:GetDocument"],
        "resource": ["*"]
      }
    ]
  }' | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name "Bounded Summarizer" \
  --instructions "You summarize notes. Use your tools when asked." \
  --tool-bindings "[{\"tool_id\":\"$WRITE_TOOL_ID\"}]" \
  --max-steps 2 \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"docs_update-document"}}]' \
  --policy-ids '["'"$READ_POLICY_ID"'"]' | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: readPolicy } = await adminSoat.policies.createPolicy({
  body: {
    name: 'summarizer-read-only',
    document: {
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
    policy_ids: [readPolicy!.id],
  },
});
const agentId = agent!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
READ_POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "summarizer-read-only",
    "document": {
      "statement": [
        {"effect": "Allow", "action": ["documents:GetDocument"], "resource": ["*"]}
      ]
    }
  }' | jq -r '.id')

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
    \"policy_ids\": [\"$READ_POLICY_ID\"]
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

:::tip Write agent policies as allow-lists
An allow-list stays correct as the agent gains tools: a newly bound `builtin` action is refused until the policy is widened. A deny-list permits every action nobody thought to deny.
:::

---

## Step 7 — Run the agent as alice, and watch the write fail

The agent's policies are evaluated before dispatch: the tool returns an error result and the [generation](/docs/modules/agents#execution-identity) still completes.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat --profile alice create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Replace the note content with: OVERWRITTEN BY THE AGENT."}]' \
  | jq '.status'

# The agent's policy refused the write — content is untouched.
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
// → "ORIGINAL CONTENT" — the agent's policy refused the write
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

The tool result the model received:

```json
{ "error": "Forbidden: boundary policy denies update-document" }
```

---

## Step 8 — Prove the ceiling was the agent's, not alice's

Same user, token and document, written directly via [Documents](/docs/modules/documents#examples).

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

The forwarded credential caps the chain from above; `policy_ids` cap each agent from below. A prompt injection inherits the agent's ceiling, not alice's.

---

## Step 9 — Attaching a policy needs its grants

An agent can do no more than whoever attached its policies. Alice may update the agent but does not hold `agents:DeleteAgent`, so she cannot hand it a policy granting that: `403 POLICY_GRANT_NOT_HELD`, with `meta.ungranted` naming the grant.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WIDE_POLICY_ID=$(soat create-policy \
  --name "summarizer-wide" \
  --document '{"statement":[{"effect":"Allow","action":["agents:DeleteAgent"]}]}' \
  | jq -r '.id')

# → expect-fail
soat --profile alice update-agent \
  --agent-id "$AGENT_ID" \
  --policy-ids '["'"$WIDE_POLICY_ID"'"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: widePolicy } = await adminSoat.policies.createPolicy({
  body: {
    name: 'summarizer-wide',
    document: {
      statement: [{ effect: 'Allow', action: ['agents:DeleteAgent'] }],
    },
  },
});

// Rejected with 403 POLICY_GRANT_NOT_HELD
await aliceSoat.agents.updateAgent({
  path: { agent_id: agentId },
  body: { policy_ids: [widePolicy!.id] },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WIDE_POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"summarizer-wide","document":{"statement":[{"effect":"Allow","action":["agents:DeleteAgent"]}]}}' \
  | jq -r '.id')

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\": [\"$WIDE_POLICY_ID\"]}" | jq '.error.code'
```

</TabItem>
</Tabs>

A mis-named action is rejected when the policy is written, so a typo'd `Deny` cannot silently match nothing. Action names: [Permissions Reference](/docs/permissions).

---

## What the agent's policies do and do not cover

|                                    | Governed by `policy_ids`                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `builtin` tools (platform actions) | **Yes** — every action is checked before dispatch                      |
| The built-in `write_memory` tool   | **Yes** — fails closed when the policies deny the memory write actions |
| `http`, `mcp`, `client` tools      | **No** — these execute outside the platform                            |

For tool types the agent's policies cannot reach, use [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails) or [Approvals](/docs/tutorials/approval-gate).

The cap applies per hop: a sub-agent called through `create-agent-generation` resolves its tools under its own `policy_ids`; the orchestrator's permissions do not widen it.

## Next Steps

- [Agents — Execution Identity](/docs/modules/agents#execution-identity) — `policy_ids` reference, including `${iam:ActorId}` per end user
- [Permissions in Practice](/docs/tutorials/permissions)
- [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration) — a policy per sub-agent
- [Gate a Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails)
