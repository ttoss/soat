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

A **harness** is the layer that decides what an agent can reach and what it is forbidden — see [The Layers of an Agent System](/docs/agent-system-layers). Terminal harnesses bundle that layer with local process execution; on SOAT you compose the same layer from platform resources, and the one piece SOAT deliberately does not own — executing code on your machine — stays in your process via [client tools](/docs/modules/tools#client).

In this tutorial you build a minimal file-assistant harness:

- **Reach** — the agent's only capability is a `read_local_file` function, declared as a client tool so SOAT never executes it.
- **Forbidden** — the harness process runs under a dedicated identity whose policy allows generations and nothing else; you prove the ceiling by watching a delete be refused.
- **The loop** — your process drives the pause-and-resume cycle: the generation stops at `requires_action`, your code reads the file locally, and the agent resumes with the real content.

## Prerequisites

- SOAT running locally with Ollama. Follow the [Quick Start](/docs/getting-started) guide, and see [Key Concepts](/docs/getting-started/concepts) if you are new to SOAT's mental model.
- An [Ollama](https://ollama.com) instance accessible at `http://ollama:11434` with model `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl available. The server is at `http://localhost:5047`. For production hardening see [Configuration](/docs/self-hosting/configuration).
- Familiar with the client-tool pause-and-resume flow? If not, run [Client Tools](/docs/tutorials/client-tools) first — this tutorial builds the identity and policy shell around that loop.

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

Admin is the built-in superuser role and bypasses policy evaluation entirely — see [IAM — Authentication](/docs/modules/iam#authentication). You use it only to assemble the harness; the harness itself will run under a far smaller identity.

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

Every resource lives inside a [project](/docs/modules/projects#examples). The [AI provider](/docs/modules/ai-providers#examples) is a local Ollama instance so the tutorial runs without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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

The harness's local capability is declared as a [client tool](/docs/modules/tools#client): a `name`, a `description`, and a JSON Schema in `parameters` — and deliberately **no** `execute` configuration. SOAT holds the contract and the pause point; the code that actually touches your filesystem lives only in your process. This is the whole reach of the agent — it has no other tool.

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

Attach the tool through [`tool_bindings`](/docs/modules/agents#tool-bindings). Two settings make the harness loop predictable:

- [`tool_choice`](/docs/modules/agents#tool-choice) `{ "type": "tool", "tool_name": "read_local_file" }` forces the first model call to invoke the function; after you submit the output, the run continues with `"auto"`.

  Forcing is passed through to the provider, so it works only where the provider implements it. [Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) does **not** support `tool_choice` and ignores the field, so a local Ollama agent falls back to `"auto"`. OpenAI, Anthropic, and xAI all honor it.
- `max_steps` bounds the agent loop.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name file-assistant \
  --instructions "You are a file assistant. When the user asks about a file, call the read_local_file tool with the path argument, then answer using the tool result." \
  --tool-bindings '[{"tool_id":"'"$TOOL_ID"'"}]' \
  --tool-choice '{"type":"tool","tool_name":"read_local_file"}' \
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
    tool_choice: { type: 'tool', tool_name: 'read_local_file' },
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
    \"tool_choice\": {\"type\": \"tool\", \"tool_name\": \"read_local_file\"},
    \"max_steps\": 3
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Forbid everything else: the harness identity

The process that runs the loop should not hold admin power. Create a dedicated user and attach a [policy](/docs/modules/policies) that allows exactly one action — `agents:CreateAgentGeneration`, which covers both starting a generation and submitting tool outputs — scoped to this project. See [IAM](/docs/modules/iam) for how policies evaluate.

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

Prove the ceiling before trusting it: the runner identity cannot even delete the agent it drives.

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

This is the whole harness runtime, from your process's point of view: start a generation, and because the model calls a client tool, the response comes back paused with `status: "requires_action"` — `required_action.tool_calls` lists what your process must execute. See [Agents — examples](/docs/modules/agents#examples) for the generation call itself.

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
Running against local Ollama and got `"status": "completed"` with `required_action: null`? That is the ignored `tool_choice` described in Step 4 — the model chose to answer instead of calling the function. Re-run the generation, or point the agent at a provider that honors forcing.
:::

Nothing is executing anywhere at this point — the generation is suspended server-side. Now your process performs the local half of the harness — the read happens on **your** machine, under whatever OS-level confinement your process runs in — and submits the result to resume the run. See [Tools — client](/docs/modules/tools#client) for the full flow.

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

The status flips to `completed` and `output.content` holds the answer, grounded in a file only your process could read. A production harness wraps exactly this cycle in a loop — one iteration per `requires_action`, submitting all pending `tool_calls` each time — while SOAT keeps the configuration, history, policy checks, and traces server-side.

---

## Step 7 — Inspect the run in the trace

Every generation writes a [trace](/docs/modules/traces#examples) recording the forced tool call, your submitted output, and the final text — the audit half of the harness, for free. Read it as admin: the runner identity cannot, which is the ceiling working as designed.

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

Two steps: the model call that proposed `read_local_file`, and the resumed call that turned your output into the answer.

---

## Where to go next

The harness you built is minimal on purpose. Each piece hardens independently:

- **Gate the tool call itself** — attach a [guardrail](/docs/modules/guardrails) to classify each call from its actual arguments before your process sees it, and route risky ones to a human [approvals](/docs/modules/approvals) queue: [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- **Cap the agent, not just the caller** — an agent-side ceiling with [`boundary_policy`](/docs/tutorials/agent-boundary-policy), so even a broader caller cannot widen this agent's reach.
- **Bound the spend** — [quotas](/docs/modules/quotas) fail closed on request, token, or cost caps: [Metering and Budgets](/docs/tutorials/metering-and-budgets).
- **Make it conversational** — the same pause-and-resume loop works in long-lived [sessions](/docs/modules/sessions), with SOAT keeping the history.
- **Ship it declaratively** — define the provider, tool, agent, and policies as one [formation](/docs/modules/formations) template: [Formations](/docs/tutorials/formations).
