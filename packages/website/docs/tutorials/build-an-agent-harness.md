---
description: 'Build an agent harness on SOAT: declare what the agent can reach as a client tool, cap what its runner identity may do with a policy, and run the pause-and-resume execution loop from your own process.'
keywords:
  - agent harness
  - harness layer
  - client tools
  - least privilege
  - requires_action
  - local execution
  - agent runner
sidebar_position: 16
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Build an Agent Harness

A harness decides what an agent can reach and what it is forbidden — see [The Layers of an Agent System](/docs/agent-system-layers). On SOAT it is composed from platform resources; code execution on your machine stays in your process via [client tools](/docs/modules/tools#client).

You build a minimal file-assistant harness:

- Reach — one `read_local_file` client tool, never executed by SOAT.
- Forbidden — the harness runs under an identity whose policy allows generations only; a delete is refused.
- The loop — the generation stops at `requires_action`, your code reads the file, the agent resumes.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [Ollama](https://ollama.com) at `http://ollama:11434` with `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl; server at `http://localhost:5047`.
- The client-tool pause-and-resume flow: [Client Tools](/docs/tutorials/client-tools).

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

Admin ([IAM — Authentication](/docs/modules/iam#authentication)) only assembles the harness; the harness runs under a smaller identity.

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

A [project](/docs/modules/projects#examples) and a local Ollama [AI provider](/docs/modules/ai-providers#examples). Other providers: [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "File Harness" | jq -r '.id')

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
  body: { name: 'File Harness' },
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
  -d '{"name":"File Harness"}' | jq -r '.id')

PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Declare the reach: a client tool

A [client tool](/docs/modules/tools#client) is a `name`, a `description` and a JSON Schema in `parameters`, with no `execute` configuration. SOAT holds the contract and the pause point; the filesystem code lives in your process. The agent has no other tool.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name read_local_file \
  --type client \
  --description "Reads a file from the local workspace and returns its content." \
  --parameters '{"type":"object","properties":{"path":{"type":"string","description":"Workspace-relative file path, e.g. notes.txt"}},"required":["path"]}' | jq -r '.id')
echo "Tool: $TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: tool } = await adminSoat.tools.createTool({
  body: {
    project_id: projectId,
    name: 'read_local_file',
    type: 'client',
    description: 'Reads a file from the local workspace and returns its content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path, e.g. notes.txt',
        },
      },
      required: ['path'],
    },
  },
});
const toolId = tool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"read_local_file\",
    \"type\": \"client\",
    \"description\": \"Reads a file from the local workspace and returns its content.\",
    \"parameters\": {\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Workspace-relative file path, e.g. notes.txt\"}},\"required\":[\"path\"]}
  }" | jq -r '.id')
echo "Tool: $TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create the agent

Attach the tool through [`tool_bindings`](/docs/modules/agents#tool-bindings). Three settings make the loop predictable:

- [`step_rules`](/docs/modules/agents#step-rules) `{ "step": 1, "tool_choice": { "type": "tool", "tool_name": "read_local_file" } }` forces the first call of the turn. Step numbering spans the pause, so the step after you submit the output is step 2 and free to answer. Agent-level [`tool_choice`](/docs/modules/agents#tool-choice) would apply to every step, the resumed one included, re-proposing the tool on each submit until `max_steps`.

  Forcing is passed through to the provider. [Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) ignores `tool_choice`, so a local Ollama agent falls back to `"auto"`; OpenAI, Anthropic and xAI honor it.
- [`stop_conditions`](/docs/modules/agents#stop-conditions) `{ "type": "has_tool_call", "tool_name": "read_local_file" }` names the call that ends the turn. Required only when the agent's own `tool_choice` forces a tool; here it documents the intended exit.
- `max_steps` is counted across the pause: the resumed turn spends what is left.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name file-assistant \
  --instructions "You are a file assistant. When the user asks about a file, call the read_local_file tool with the path argument, then answer using the tool result." \
  --tool-bindings '[{"tool_id":"'"$TOOL_ID"'"}]' \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"read_local_file"}}]' \
  --stop-conditions '[{"type":"has_tool_call","tool_name":"read_local_file"}]' \
  --max-steps 3 | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: projectId,
    ai_provider_id: providerId,
    name: 'file-assistant',
    instructions:
      'You are a file assistant. When the user asks about a file, call the read_local_file tool with the path argument, then answer using the tool result.',
    tool_bindings: [{ tool_id: toolId }],
    step_rules: [
      { step: 1, tool_choice: { type: 'tool', tool_name: 'read_local_file' } },
    ],
    stop_conditions: [{ type: 'has_tool_call', tool_name: 'read_local_file' }],
    max_steps: 3,
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
    \"name\": \"file-assistant\",
    \"instructions\": \"You are a file assistant. When the user asks about a file, call the read_local_file tool with the path argument, then answer using the tool result.\",
    \"tool_bindings\": [{\"tool_id\": \"$TOOL_ID\"}],
    \"step_rules\": [{\"step\": 1, \"tool_choice\": {\"type\": \"tool\", \"tool_name\": \"read_local_file\"}}],
    \"stop_conditions\": [{\"type\": \"has_tool_call\", \"tool_name\": \"read_local_file\"}],
    \"max_steps\": 3
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Forbid everything else: the harness identity

A dedicated user with a [policy](/docs/modules/policies) allowing one action, `agents:CreateAgentGeneration` (covers starting a generation and submitting tool outputs), scoped to this project. See [IAM](/docs/modules/iam).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUNNER_ID=$(soat create-user --username harness-runner --password Runner1234! | jq -r '.id')

RUNNER_POLICY_ID=$(soat create-policy \
  --name "harness-runner-policy" \
  --description "Generations only, in the File Harness project" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["agents:CreateAgentGeneration"],
        "resource": ["srn:'"$PROJECT_ID"':*:*"]
      }
    ]
  }' | jq -r '.id')

soat attach-user-policies --user-id "$RUNNER_ID" --policy-ids '["'"$RUNNER_POLICY_ID"'"]'

RUNNER_TOKEN=$(soat login-user --username harness-runner --password Runner1234! | jq -r '.token')
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: runner } = await adminSoat.users.createUser({
  body: { username: 'harness-runner', password: 'Runner1234!' },
});

const { data: runnerPolicy } = await adminSoat.policies.createPolicy({
  body: {
    name: 'harness-runner-policy',
    description: 'Generations only, in the File Harness project',
    document: {
      statement: [
        {
          effect: 'Allow',
          action: ['agents:CreateAgentGeneration'],
          resource: [`srn:${projectId}:*:*`],
        },
      ],
    },
  },
});

await adminSoat.users.attachUserPolicies({
  path: { user_id: runner!.id },
  body: { policy_ids: [runnerPolicy!.id] },
});

const { data: runnerSession } = await soat.users.loginUser({
  body: { username: 'harness-runner', password: 'Runner1234!' },
});

const runnerSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: runnerSession!.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUNNER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"harness-runner","password":"Runner1234!"}' | jq -r '.id')

RUNNER_POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "harness-runner-policy",
    "description": "Generations only, in the File Harness project",
    "document": {
      "statement": [
        {
          "effect": "Allow",
          "action": ["agents:CreateAgentGeneration"],
          "resource": ["srn:'"$PROJECT_ID"':*:*"]
        }
      ]
    }
  }' | jq -r '.id')

curl -s -X PUT "$SOAT_BASE_URL/api/v1/users/$RUNNER_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"policy_ids":["'"$RUNNER_POLICY_ID"'"]}'

RUNNER_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"harness-runner","password":"Runner1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

The runner identity cannot delete the agent it drives:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → 403
SOAT_TOKEN="$RUNNER_TOKEN" soat delete-agent --agent-id "$AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Refused with 403 — the runner's policy has no agents:DeleteAgent.
await runnerSoat.agents.deleteAgent({ path: { agent_id: agentId } });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE \
  "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
# 403
```

</TabItem>
</Tabs>

---

## Step 6 — Run the harness loop

Start a generation; the model calls the client tool and the response pauses with `status: "requires_action"`, `required_action.tool_calls` listing what your process must execute. See [Agents — examples](/docs/modules/agents#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
printf 'Standup is moved to 10:30 on Fridays.\n' > notes.txt

GEN_RESPONSE=$(SOAT_TOKEN="$RUNNER_TOKEN" soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"What does notes.txt say?"}]')
echo "$GEN_RESPONSE" | jq '{status, required_action}'

GEN_ID=$(echo "$GEN_RESPONSE" | jq -r '.id')
TRACE_ID=$(echo "$GEN_RESPONSE" | jq -r '.trace_id')
TOOL_CALL_ID=$(echo "$GEN_RESPONSE" | jq -r '.required_action.tool_calls[0].id')
echo "$GEN_RESPONSE" | jq -e '.status == "requires_action"' > /dev/null
echo "Generation $GEN_ID paused; pending tool call: $TOOL_CALL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { writeFileSync, readFileSync } from 'node:fs';

writeFileSync('notes.txt', 'Standup is moved to 10:30 on Fridays.\n');

const { data: generation } = await runnerSoat.agents.createAgentGeneration({
  path: { agent_id: agentId },
  query: { wait: true },
  body: {
    messages: [{ role: 'user', content: 'What does notes.txt say?' }],
  },
});

console.log(generation!.status); // "requires_action"
const toolCall = generation!.required_action!.tool_calls[0];
console.log(toolCall.tool_name, toolCall.args); // "read_local_file" { path: "notes.txt" }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
printf 'Standup is moved to 10:30 on Fridays.\n' > notes.txt

GEN_RESPONSE=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What does notes.txt say?"}]}')
echo "$GEN_RESPONSE" | jq '{status, required_action}'

GEN_ID=$(echo "$GEN_RESPONSE" | jq -r '.id')
TRACE_ID=$(echo "$GEN_RESPONSE" | jq -r '.trace_id')
TOOL_CALL_ID=$(echo "$GEN_RESPONSE" | jq -r '.required_action.tool_calls[0].id')
```

</TabItem>
</Tabs>

:::note
`"status": "completed"` with `required_action: null` on local Ollama is the ignored `tool_choice` from Step 4. Re-run, or use a provider that honors forcing.
:::

The generation is suspended server-side. Your process reads the file locally and submits the result to resume the run. See [Tools — client](/docs/modules/tools#client).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# The local execution half of the harness: read the file this process can see.
FILE_CONTENT=$(cat notes.txt)

# Small local models occasionally emit raw control characters in the final
# text; strip them so jq can parse the response.
FINAL_RESPONSE=$(SOAT_TOKEN="$RUNNER_TOKEN" soat submit-agent-tool-outputs \
  --agent-id "$AGENT_ID" \
  --generation-id "$GEN_ID" \
  --tool-outputs '[{"tool_call_id":"'"$TOOL_CALL_ID"'","output":{"path":"notes.txt","content":"'"$FILE_CONTENT"'"}}]' | LC_ALL=C tr -d '\000-\037')

echo "$FINAL_RESPONSE" | jq '{status, content: .output.content}'
echo "$FINAL_RESPONSE" | jq -e '.status == "completed"' > /dev/null
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// The local execution half of the harness: read the file this process can see.
const fileContent = readFileSync('notes.txt', 'utf8');

const { data: final } = await runnerSoat.agents.submitAgentToolOutputs({
  path: { agent_id: agentId, generation_id: generation!.id },
  body: {
    tool_outputs: [
      {
        tool_call_id: toolCall.id,
        output: { path: 'notes.txt', content: fileContent },
      },
    ],
  },
});

console.log(final!.status); // "completed"
console.log(final!.output!.content); // "notes.txt says the standup moved to 10:30..."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FILE_CONTENT=$(cat notes.txt)

FINAL_RESPONSE=$(curl -s -X POST \
  "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate/$GEN_ID/tool-outputs" \
  -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool_outputs":[{"tool_call_id":"'"$TOOL_CALL_ID"'","output":{"path":"notes.txt","content":"'"$FILE_CONTENT"'"}}]}' | LC_ALL=C tr -d '\000-\037')

echo "$FINAL_RESPONSE" | jq '{status, content: .output.content}'
```

</TabItem>
</Tabs>

Status is `completed` and `output.content` holds the answer. A production harness loops this cycle, one iteration per `requires_action`, submitting all pending `tool_calls` each time.

---

## Step 7 — Inspect the run in the trace

Every generation writes a [trace](/docs/modules/traces#examples) with the forced tool call, your submitted output and the final text. Read it as admin; the runner identity cannot.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-trace --trace-id "$TRACE_ID" | jq '{id, agent_id, step_count, file_id}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: trace } = await adminSoat.traces.getTrace({
  path: { trace_id: generation!.trace_id },
});
console.log(trace!.id, trace!.step_count, trace!.file_id);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/traces/$TRACE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, agent_id, step_count, file_id}'
```

</TabItem>
</Tabs>

Two steps: the call that proposed `read_local_file`, and the resumed call that produced the answer.

---

## Where to go next

- Gate the tool call with a [guardrail](/docs/modules/guardrails) or an [approvals](/docs/modules/approvals) queue: [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- Cap the agent itself with [`boundary_policy`](/docs/tutorials/agent-boundary-policy).
- Bound spend with [quotas](/docs/modules/quotas): [Metering and Budgets](/docs/tutorials/metering-and-budgets).
- Run the same loop in long-lived [sessions](/docs/modules/sessions).
- Ship provider, tool, agent and policies as one [formation](/docs/modules/formations): [Formations](/docs/tutorials/formations).
