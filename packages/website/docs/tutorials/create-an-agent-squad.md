---
sidebar_position: 12
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Create an Agent Squad

An **agent squad** is a team of agents plus the flow that coordinates them, deployed as a single [Formation](/docs/modules/formations) stack — see the [Agent Squad example](/docs/modules/orchestrations#agent-squad). This tutorial builds a small marketing content squad end to end: a researcher gathers facts, a writer and a reviewer work in parallel from those facts, a human reviewer approves the result, and only then does it "publish".

You will:

1. Design the squad: member roles, instructions, and the flow that connects them.
2. Write a formation template declaring the agents and the squad [orchestration](/docs/modules/orchestrations) in one document, using `{ "ref": ... }` to cross-reference resources declared in the same template.
3. Validate the template and preview the deployment plan.
4. Deploy the stack and read the `squad_id` output.
5. Run the squad and inspect which node is waiting on you.
6. Resume the `human` approval node and read the published result.
7. Add a member to the squad and redeploy.
8. Tear down the stack.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and orchestrations before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- Server is at `http://localhost:5047`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { createConfig, SoatClient } from '@soat/sdk';

const config = createConfig({ baseUrl: 'http://localhost:5047', auth: '' });
const adminSoat = new SoatClient(config);
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

Admin is the built-in superuser. See [Users](/docs/modules/users#examples) for full authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session } = await adminSoat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});
const authClient = new SoatClient(
  createConfig({ baseUrl: 'http://localhost:5047', auth: session.token })
);
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

All resources are scoped to a [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name 'Content Squad' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await authClient.projects.createProject({
  body: { name: 'Content Squad' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Content Squad"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Design the squad

The squad has three [agents](/docs/modules/agents) plus a human checkpoint, wired together by one [orchestration](/docs/modules/orchestrations):

| Node        | Type    | Role                                                                          |
| ----------- | ------- | ------------------------------------------------------------------------------ |
| `research`  | agent   | Gathers 3 short bullet facts about the topic                                   |
| `write`     | agent   | Drafts a two-sentence marketing blurb from the research (runs in parallel with `review`) |
| `review`    | agent   | Writes one sentence of style guidance from the same research (runs in parallel with `write`) |
| `approve`   | human   | Pauses the run so a person can approve the draft before it "publishes"          |
| `publish`   | transform | Combines the approved draft into the final artifact                          |

`research` fans out to `write` and `review`, which fan back in at `approve` using an [activation group](/docs/modules/orchestrations#activation-groups-fan-in) — `approve` only activates once **both** finish. This is the [Agent Squad](/docs/modules/orchestrations#agent-squad) pattern: because an orchestration is a formation resource type, the three agents and the orchestration that coordinates them are declared and deployed together in the next step.

---

## Step 4 — Write the formation template

A [formation template](/docs/modules/formations#formation-template) is a JSON object with a `resources` map and an `outputs` map. `ContentSquad`'s nodes reference `Researcher`, `Writer`, and `Reviewer` with `{ "ref": "LogicalId" }` — SOAT resolves each to its physical `agent_...` ID before creating the orchestration, in dependency order. See [Ref Expressions](/docs/modules/formations#ref-expressions).

This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
cat > squad.json << 'EOF'
{
  "resources": {
    "Provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Squad Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "Researcher": {
      "type": "agent",
      "properties": {
        "name": "Researcher",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "You are a research assistant. Given a topic, reply with exactly 3 short bullet facts. Never ask follow-up questions.",
        "max_steps": 3
      }
    },
    "Writer": {
      "type": "agent",
      "properties": {
        "name": "Writer",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "You are a marketing writer. Given research notes, write a two-sentence marketing blurb. Never ask follow-up questions.",
        "max_steps": 3
      }
    },
    "Reviewer": {
      "type": "agent",
      "properties": {
        "name": "Reviewer",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "You are an editor. Given research notes, write one sentence of style guidance for the writer. Never ask follow-up questions.",
        "max_steps": 3
      }
    },
    "ContentSquad": {
      "type": "orchestration",
      "properties": {
        "name": "marketing-content-squad",
        "input_schema": {
          "type": "object",
          "properties": { "topic": { "type": "string" } },
          "required": ["topic"]
        },
        "nodes": [
          {
            "id": "research",
            "type": "agent",
            "agent_id": { "ref": "Researcher" },
            "input_mapping": { "prompt": { "var": "topic" } },
            "output_mapping": { "content": "state.research" }
          },
          {
            "id": "write",
            "type": "agent",
            "agent_id": { "ref": "Writer" },
            "input_mapping": { "prompt": { "var": "research" } },
            "output_mapping": { "content": "state.draft" }
          },
          {
            "id": "review",
            "type": "agent",
            "agent_id": { "ref": "Reviewer" },
            "input_mapping": { "prompt": { "var": "research" } },
            "output_mapping": { "content": "state.notes" }
          },
          {
            "id": "approve",
            "type": "human",
            "prompt": "Approve the draft for publishing?",
            "options": ["approve", "reject"],
            "input_mapping": { "draft": { "var": "draft" }, "notes": { "var": "notes" } },
            "output_mapping": { "approved": "state.approved" }
          },
          {
            "id": "publish",
            "type": "transform",
            "expression": { "cat": ["Published: ", { "var": "draft" }] },
            "output_mapping": { "result": "state.published" }
          }
        ],
        "edges": [
          { "from": "research", "to": "write" },
          { "from": "research", "to": "review" },
          { "from": "write", "to": "approve", "activation_group": "join", "activation_condition": "all" },
          { "from": "review", "to": "approve", "activation_group": "join", "activation_condition": "all" },
          { "from": "approve", "to": "publish" }
        ]
      }
    }
  },
  "outputs": {
    "squad_id": { "ref": "ContentSquad" }
  }
}
EOF
TEMPLATE=$(cat squad.json)
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const template = {
  resources: {
    Provider: {
      type: 'ai_provider',
      properties: { name: 'Squad Ollama', provider: 'ollama', default_model: 'qwen2.5:0.5b' },
    },
    Researcher: {
      type: 'agent',
      properties: {
        name: 'Researcher',
        ai_provider_id: { ref: 'Provider' },
        instructions:
          'You are a research assistant. Given a topic, reply with exactly 3 short bullet facts. Never ask follow-up questions.',
        max_steps: 3,
      },
    },
    Writer: {
      type: 'agent',
      properties: {
        name: 'Writer',
        ai_provider_id: { ref: 'Provider' },
        instructions:
          'You are a marketing writer. Given research notes, write a two-sentence marketing blurb. Never ask follow-up questions.',
        max_steps: 3,
      },
    },
    Reviewer: {
      type: 'agent',
      properties: {
        name: 'Reviewer',
        ai_provider_id: { ref: 'Provider' },
        instructions:
          'You are an editor. Given research notes, write one sentence of style guidance for the writer. Never ask follow-up questions.',
        max_steps: 3,
      },
    },
    ContentSquad: {
      type: 'orchestration',
      properties: {
        name: 'marketing-content-squad',
        input_schema: {
          type: 'object',
          properties: { topic: { type: 'string' } },
          required: ['topic'],
        },
        nodes: [
          {
            id: 'research',
            type: 'agent',
            agent_id: { ref: 'Researcher' },
            input_mapping: { prompt: { var: 'topic' } },
            output_mapping: { content: 'state.research' },
          },
          {
            id: 'write',
            type: 'agent',
            agent_id: { ref: 'Writer' },
            input_mapping: { prompt: { var: 'research' } },
            output_mapping: { content: 'state.draft' },
          },
          {
            id: 'review',
            type: 'agent',
            agent_id: { ref: 'Reviewer' },
            input_mapping: { prompt: { var: 'research' } },
            output_mapping: { content: 'state.notes' },
          },
          {
            id: 'approve',
            type: 'human',
            prompt: 'Approve the draft for publishing?',
            options: ['approve', 'reject'],
            input_mapping: { draft: { var: 'draft' }, notes: { var: 'notes' } },
            output_mapping: { approved: 'state.approved' },
          },
          {
            id: 'publish',
            type: 'transform',
            expression: { cat: ['Published: ', { var: 'draft' }] },
            output_mapping: { result: 'state.published' },
          },
        ],
        edges: [
          { from: 'research', to: 'write' },
          { from: 'research', to: 'review' },
          { from: 'write', to: 'approve', activation_group: 'join', activation_condition: 'all' },
          { from: 'review', to: 'approve', activation_group: 'join', activation_condition: 'all' },
          { from: 'approve', to: 'publish' },
        ],
      },
    },
  },
  outputs: { squad_id: { ref: 'ContentSquad' } },
};
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
cat > squad.json << 'EOF'
{
  "resources": {
    "Provider": {
      "type": "ai_provider",
      "properties": { "name": "Squad Ollama", "provider": "ollama", "default_model": "qwen2.5:0.5b" }
    },
    "Researcher": {
      "type": "agent",
      "properties": {
        "name": "Researcher",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "You are a research assistant. Given a topic, reply with exactly 3 short bullet facts. Never ask follow-up questions.",
        "max_steps": 3
      }
    },
    "Writer": {
      "type": "agent",
      "properties": {
        "name": "Writer",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "You are a marketing writer. Given research notes, write a two-sentence marketing blurb. Never ask follow-up questions.",
        "max_steps": 3
      }
    },
    "Reviewer": {
      "type": "agent",
      "properties": {
        "name": "Reviewer",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "You are an editor. Given research notes, write one sentence of style guidance for the writer. Never ask follow-up questions.",
        "max_steps": 3
      }
    },
    "ContentSquad": {
      "type": "orchestration",
      "properties": {
        "name": "marketing-content-squad",
        "input_schema": {
          "type": "object",
          "properties": { "topic": { "type": "string" } },
          "required": ["topic"]
        },
        "nodes": [
          {
            "id": "research",
            "type": "agent",
            "agent_id": { "ref": "Researcher" },
            "input_mapping": { "prompt": { "var": "topic" } },
            "output_mapping": { "content": "state.research" }
          },
          {
            "id": "write",
            "type": "agent",
            "agent_id": { "ref": "Writer" },
            "input_mapping": { "prompt": { "var": "research" } },
            "output_mapping": { "content": "state.draft" }
          },
          {
            "id": "review",
            "type": "agent",
            "agent_id": { "ref": "Reviewer" },
            "input_mapping": { "prompt": { "var": "research" } },
            "output_mapping": { "content": "state.notes" }
          },
          {
            "id": "approve",
            "type": "human",
            "prompt": "Approve the draft for publishing?",
            "options": ["approve", "reject"],
            "input_mapping": { "draft": { "var": "draft" }, "notes": { "var": "notes" } },
            "output_mapping": { "approved": "state.approved" }
          },
          {
            "id": "publish",
            "type": "transform",
            "expression": { "cat": ["Published: ", { "var": "draft" }] },
            "output_mapping": { "result": "state.published" }
          }
        ],
        "edges": [
          { "from": "research", "to": "write" },
          { "from": "research", "to": "review" },
          { "from": "write", "to": "approve", "activation_group": "join", "activation_condition": "all" },
          { "from": "review", "to": "approve", "activation_group": "join", "activation_condition": "all" },
          { "from": "approve", "to": "publish" }
        ]
      }
    }
  },
  "outputs": {
    "squad_id": { "ref": "ContentSquad" }
  }
}
EOF
TEMPLATE=$(cat squad.json)
```

</TabItem>
</Tabs>

---

## Step 5 — Validate and preview the template

Validate the template's structure, then preview what will be created. See [Formations — Key Concepts](/docs/modules/formations#key-concepts).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat validate-formation --template "$TEMPLATE"
```

Expected output:

```json
{ "valid": true }
```

```bash
soat plan-formation --project-id "$PROJECT_ID" --template "$TEMPLATE" | jq '.'
```

Expected output — 5 resources all marked as `create`:

```json
[
  { "action": "create", "logical_id": "Provider", "type": "ai_provider" },
  { "action": "create", "logical_id": "Researcher", "type": "agent" },
  { "action": "create", "logical_id": "Writer", "type": "agent" },
  { "action": "create", "logical_id": "Reviewer", "type": "agent" },
  { "action": "create", "logical_id": "ContentSquad", "type": "orchestration" }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: validation } = await authClient.formations.validateFormation({
  body: { template },
});
console.log('Valid:', validation.valid);

const { data: plan } = await authClient.formations.planFormation({
  body: { project_id: PROJECT_ID, template },
});
for (const change of plan) {
  console.log(`${change.action.padEnd(8)} ${change.logical_id} (${change.type})`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/formations/validate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"template\": $TEMPLATE}" | jq '.'

curl -s -X POST "$SOAT_URL/api/v1/formations/plan" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"template\": $TEMPLATE}" | jq '.'
```

</TabItem>
</Tabs>

---

## Step 6 — Deploy the squad

Deploy the formation. SOAT provisions the provider, all three agents, and the orchestration in dependency order, and resolves every `ref` expression. See [Formations — Examples](/docs/modules/formations#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FORMATION=$(soat create-formation \
  --project-id "$PROJECT_ID" \
  --name "content-squad" \
  --template "$TEMPLATE")

FORMATION_ID=$(printf '%s' "$FORMATION" | jq -r '.id')
SQUAD_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.squad_id')

echo "FORMATION_ID: $FORMATION_ID"
echo "SQUAD_ID:     $SQUAD_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: formation } = await authClient.formations.createFormation({
  body: { project_id: PROJECT_ID, name: 'content-squad', template },
});
const FORMATION_ID = formation.id;
const SQUAD_ID = formation.outputs?.squad_id as string;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FORMATION=$(curl -s -X POST "$SOAT_URL/api/v1/formations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"name\": \"content-squad\", \"template\": $TEMPLATE}")

FORMATION_ID=$(printf '%s' "$FORMATION" | jq -r '.id')
SQUAD_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.squad_id')
```

</TabItem>
</Tabs>

---

## Step 7 — Run the squad

Start a run against the `squad_id` output, passing `{ "topic": "..." }` as [`input`](/docs/modules/orchestrations#state-and-mappings). `research` runs first, then `write` and `review` run in parallel, then the run pauses at the `approve` [human node](/docs/modules/orchestrations#human-nodes).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN=$(soat start-orchestration-run \
  --orchestration-id "$SQUAD_ID" \
  --input '{"topic": "the launch of a new project management app"}' \
  --wait)

RUN_ID=$(printf '%s' "$RUN" | jq -r '.id')
printf '%s\n' "$RUN" | jq '{status, required_action}'
```

Expected output — the run pauses at `approve`:

```json
{
  "status": "awaiting_input",
  "required_action": {
    "type": "human_input",
    "node_id": "approve",
    "prompt": "Approve the draft for publishing?",
    "options": ["approve", "reject"],
    "context": { "draft": "...", "notes": "..." }
  }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await authClient.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: SQUAD_ID,
    input: { topic: 'the launch of a new project management app' },
    wait: true,
  },
});
const RUN_ID = run.id;
console.log('Status:', run.status);
console.log('Required action:', run.required_action);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN=$(curl -s -X POST "$SOAT_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id": "'"$SQUAD_ID"'", "input": {"topic": "the launch of a new project management app"}, "wait": true}')

RUN_ID=$(printf '%s' "$RUN" | jq -r '.id')
printf '%s\n' "$RUN" | jq '{status, required_action}'
```

</TabItem>
</Tabs>

---

## Step 8 — Resume the human approval node

Submit the human reviewer's decision with [`submit-human-input`](/docs/modules/orchestrations#human-nodes), naming the paused `node_id`. The run resumes and runs `publish`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RESULT=$(soat submit-human-input \
  --run-id "$RUN_ID" \
  --node-id "approve" \
  --output '{"approved": true}')

printf '%s\n' "$RESULT" | jq '{status, state}'
```

Expected output:

```json
{
  "status": "succeeded",
  "state": {
    "research": "...",
    "draft": "...",
    "notes": "...",
    "approved": true,
    "published": "Published: ..."
  }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: resumed } = await authClient.orchestrations.submitHumanInput({
  path: { run_id: RUN_ID },
  body: { node_id: 'approve', output: { approved: true } },
});
console.log('Status:', resumed.status);
console.log('Published:', resumed.state.published);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/orchestration-runs/$RUN_ID/human-input" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"node_id": "approve", "output": {"approved": true}}' | jq '{status, state}'
```

</TabItem>
</Tabs>

Inspect the [per-node executions](/docs/modules/orchestrations#node-executions) to see who did what:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-orchestration-run --run-id "$RUN_ID" | jq '.node_executions[] | {node_id, node_type, status}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: finished } = await authClient.orchestrations.getOrchestrationRun({
  path: { run_id: RUN_ID },
});
for (const exec of finished.node_executions) {
  console.log(exec.node_id, exec.node_type, exec.status);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/orchestration-runs/$RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.node_executions[] | {node_id, node_type, status}'
```

</TabItem>
</Tabs>

---

## Step 9 — Add a squad member and redeploy

Add a `Proofreader` agent that also runs in parallel with `write` and `review`, feeding the same `approve` fan-in. Update the template's `resources` and the `approve` node's edges, then redeploy — SOAT diffs the new template against the current stack and applies only the required changes. See [Formations — Update a formation](/docs/modules/formations#update-a-formation).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
UPDATED_TEMPLATE=$(printf '%s' "$TEMPLATE" | jq '
  .resources.Proofreader = {
    "type": "agent",
    "properties": {
      "name": "Proofreader",
      "ai_provider_id": { "ref": "Provider" },
      "instructions": "You are a proofreader. Given research notes, list any factual claims that need a citation. Never ask follow-up questions.",
      "max_steps": 3
    }
  } |
  .resources.ContentSquad.properties.nodes += [{
    "id": "proofread",
    "type": "agent",
    "agent_id": { "ref": "Proofreader" },
    "input_mapping": { "prompt": { "var": "research" } },
    "output_mapping": { "content": "state.citationNotes" }
  }] |
  .resources.ContentSquad.properties.edges += [
    { "from": "research", "to": "proofread" },
    { "from": "proofread", "to": "approve", "activation_group": "join", "activation_condition": "all" }
  ]
')

soat plan-formation --formation-id "$FORMATION_ID" --template "$UPDATED_TEMPLATE" | jq '.'

soat update-formation \
  --formation-id "$FORMATION_ID" \
  --template "$UPDATED_TEMPLATE" | jq '{id, status}'
```

Expected plan — one new resource, one updated resource:

```json
[
  { "action": "create", "logical_id": "Proofreader", "type": "agent" },
  { "action": "update", "logical_id": "ContentSquad", "type": "orchestration" }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const updatedTemplate = JSON.parse(JSON.stringify(template));
updatedTemplate.resources.Proofreader = {
  type: 'agent',
  properties: {
    name: 'Proofreader',
    ai_provider_id: { ref: 'Provider' },
    instructions:
      'You are a proofreader. Given research notes, list any factual claims that need a citation. Never ask follow-up questions.',
    max_steps: 3,
  },
};
updatedTemplate.resources.ContentSquad.properties.nodes.push({
  id: 'proofread',
  type: 'agent',
  agent_id: { ref: 'Proofreader' },
  input_mapping: { prompt: { var: 'research' } },
  output_mapping: { content: 'state.citationNotes' },
});
updatedTemplate.resources.ContentSquad.properties.edges.push(
  { from: 'research', to: 'proofread' },
  { from: 'proofread', to: 'approve', activation_group: 'join', activation_condition: 'all' }
);

const { data: updated } = await authClient.formations.updateFormation({
  path: { formation_id: FORMATION_ID },
  body: { template: updatedTemplate },
});
console.log('Status:', updated.status);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
UPDATED_TEMPLATE=$(printf '%s' "$TEMPLATE" | jq '
  .resources.Proofreader = {
    "type": "agent",
    "properties": {
      "name": "Proofreader",
      "ai_provider_id": { "ref": "Provider" },
      "instructions": "You are a proofreader. Given research notes, list any factual claims that need a citation. Never ask follow-up questions.",
      "max_steps": 3
    }
  } |
  .resources.ContentSquad.properties.nodes += [{
    "id": "proofread",
    "type": "agent",
    "agent_id": { "ref": "Proofreader" },
    "input_mapping": { "prompt": { "var": "research" } },
    "output_mapping": { "content": "state.citationNotes" }
  }] |
  .resources.ContentSquad.properties.edges += [
    { "from": "research", "to": "proofread" },
    { "from": "proofread", "to": "approve", "activation_group": "join", "activation_condition": "all" }
  ]
')

curl -s -X PUT "$SOAT_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"template\": $UPDATED_TEMPLATE}" | jq '{id, status}'
```

</TabItem>
</Tabs>

---

## Step 10 — Tear down

Deleting a formation removes managed resources in reverse dependency order. See [Formations — Key Concepts](/docs/modules/formations#resource-lifecycle).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat delete-formation --formation-id "$FORMATION_ID" | jq '.'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: deletion } = await authClient.formations.deleteFormation({
  path: { formation_id: FORMATION_ID },
});
console.log('delete success:', deletion?.success);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X DELETE "$SOAT_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

</TabItem>
</Tabs>

---

## Summary

| Concept                  | What you did                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Agent squad               | Declared a team of 3 agents plus the coordinating orchestration in a single template     |
| `{ "ref": ... }`          | Wired `ai_provider_id` and `agent_id` across resources in the same template               |
| Fan-out / fan-in          | `research` fanned out to `write` and `review`; an `activation_group` fanned them back in |
| Human node                | Paused the run at `approve` and resumed it with `submit-human-input`                     |
| Validate and plan         | Checked the template and previewed create/update actions before deploying                |
| Deploy                    | Created the provider, agents, and orchestration in one call                              |
| Update                    | Added a `Proofreader` agent and a new fan-in edge; SOAT applied only the diff             |
| Delete                    | Removed all managed resources in reverse dependency order                                |
