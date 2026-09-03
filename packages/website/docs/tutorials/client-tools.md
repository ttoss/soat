---
description: 'Implement function calling with SOAT client tools: the agent pauses at requires_action, your app executes the function locally, then submits the tool output to resume the run.'
keywords:
  - function calling
  - client tools
  - AI agent tool calling
  - requires_action
  - submit tool outputs
  - client-side tool execution
  - human in the loop
sidebar_position: 5
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Execute Agent Tool Calls in Your Own App (Client Tools)

A [client tool](/docs/modules/tools#client) declares a function's contract so the model can decide to call it — but SOAT never executes it. The generation pauses with status `requires_action`, hands the pending tool calls to your app, and resumes when you submit the results — the same loop as function calling with the OpenAI or Anthropic APIs, with configuration, history, and traces managed server-side.

In this tutorial you build an order-support agent whose `get_order_status` function is a client tool: the agent pauses at `requires_action`, your app looks the order up and submits the result, and the agent resumes with real data.

## Prerequisites

- SOAT running locally with Ollama. Follow the [Quick Start](/docs/getting-started) guide, and see [Key Concepts](/docs/getting-started/concepts) if you are new to SOAT's mental model.
- An Ollama instance accessible at `http://ollama:11434` with model `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`). See [Ollama](https://ollama.com) for installation.
- CLI, SDK, or curl available. The server is at `http://localhost:5047`. For production hardening see [Configuration](/docs/self-hosting/configuration).

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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [IAM — Authentication](/docs/modules/iam#authentication) for details on JWT tokens and the admin role.

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

## Step 2 — Create a project

Every resource in SOAT lives inside a [project](/docs/modules/projects#examples). Create one to hold the AI provider, the tool, and the agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Order Support" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Order Support' },
});
const projectId = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Order Support"}' | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an Ollama AI provider

Set up a local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "Provider: $PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
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
PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')
echo "Provider: $PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Declare the function as a client tool

A [client tool](/docs/modules/tools#client) has a `name`, a `description`, and a JSON Schema in `parameters` — and deliberately **no** `execute` configuration. The schema is what the model sees, so write it the way you want the model to call your function. Parameter keys are caller-owned: SOAT hands them back to your app exactly as you author them here (`orderId` stays `orderId`).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name get_order_status \
  --type client \
  --description "Looks up an order in the store database and returns its status." \
  --parameters '{"type":"object","properties":{"orderId":{"type":"string","description":"The order ID, e.g. ord_1042"}},"required":["orderId"]}' | jq -r '.id')
echo "Tool: $TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: tool } = await adminSoat.tools.createTool({
  body: {
    project_id: projectId,
    name: 'get_order_status',
    type: 'client',
    description:
      'Looks up an order in the store database and returns its status.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The order ID, e.g. ord_1042',
        },
      },
      required: ['orderId'],
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
    \"name\": \"get_order_status\",
    \"type\": \"client\",
    \"description\": \"Looks up an order in the store database and returns its status.\",
    \"parameters\": {\"type\":\"object\",\"properties\":{\"orderId\":{\"type\":\"string\",\"description\":\"The order ID, e.g. ord_1042\"}},\"required\":[\"orderId\"]}
  }" | jq -r '.id')
echo "Tool: $TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create the agent

Attach the tool through [`tool_bindings`](/docs/modules/agents#tool-bindings), the canonical attachment field. Three settings make the pause-and-resume loop predictable:

- [`step_rules`](/docs/modules/agents#step-rules) `{ "step": 1, "tool_choice": { "type": "tool", "tool_name": "get_order_status" } }` forces the **first** call of the turn to invoke the function. Step numbering spans the pause, so the step that runs after you submit the output is step 2 and free to answer.

  Forcing at agent level instead ([`tool_choice`](/docs/modules/agents#tool-choice)) would apply to *every* step of the turn, the resumed one included — the run would propose the same client tool again on each submit until `max_steps` ended it.

  Forcing is passed through to the provider, so it works only where the provider implements it. [Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) does **not** support `tool_choice` and ignores the field, so a local Ollama agent falls back to `"auto"`. OpenAI, Anthropic, and xAI all honor it.
- [`stop_conditions`](/docs/modules/agents#stop-conditions) `{ "type": "has_tool_call", "tool_name": "get_order_status" }` names the call that ends the turn. It is required only when the agent's own `tool_choice` forces a tool — a step rule leaves the agent at `"auto"`, so here it is documentation of the intended exit.
- `max_steps` bounds the agent loop, counted across the pause: the resumed turn spends what is left of it, never a fresh budget.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name order-support-agent \
  --instructions "You are an order-support assistant. When the user asks about an order, call the get_order_status tool with the orderId argument, then answer using the tool result." \
  --tool-bindings '[{"tool_id":"'"$TOOL_ID"'"}]' \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"get_order_status"}}]' \
  --stop-conditions '[{"type":"has_tool_call","tool_name":"get_order_status"}]' \
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
    name: 'order-support-agent',
    instructions:
      'You are an order-support assistant. When the user asks about an order, call the get_order_status tool with the orderId argument, then answer using the tool result.',
    tool_bindings: [{ tool_id: toolId }],
    step_rules: [
      { step: 1, tool_choice: { type: 'tool', tool_name: 'get_order_status' } },
    ],
    stop_conditions: [{ type: 'has_tool_call', tool_name: 'get_order_status' }],
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
    \"name\": \"order-support-agent\",
    \"instructions\": \"You are an order-support assistant. When the user asks about an order, call the get_order_status tool with the orderId argument, then answer using the tool result.\",
    \"tool_bindings\": [{\"tool_id\": \"$TOOL_ID\"}],
    \"step_rules\": [{\"step\": 1, \"tool_choice\": {\"type\": \"tool\", \"tool_name\": \"get_order_status\"}}],
    \"stop_conditions\": [{\"type\": \"has_tool_call\", \"tool_name\": \"get_order_status\"}],
    \"max_steps\": 3
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Ask about an order: the generation pauses

Start a generation as for any [agent](/docs/modules/agents#examples). Because the model calls a client tool, the response comes back with `status: "requires_action"`, and `required_action.tool_calls` lists what your app must execute — each entry has an `id`, the `tool_name`, and the model-supplied `args`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
GEN_RESPONSE=$(soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"What is the status of order ord_1042?"}]')
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
const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: agentId },
  query: { wait: true },
  body: {
    messages: [
      { role: 'user', content: 'What is the status of order ord_1042?' },
    ],
  },
});

console.log(generation!.status); // "requires_action"
const toolCall = generation!.required_action!.tool_calls[0];
console.log(toolCall.tool_name, toolCall.args); // "get_order_status" { orderId: "ord_1042" }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
GEN_RESPONSE=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the status of order ord_1042?"}]}')
echo "$GEN_RESPONSE" | jq '{status, required_action}'

GEN_ID=$(echo "$GEN_RESPONSE" | jq -r '.id')
TRACE_ID=$(echo "$GEN_RESPONSE" | jq -r '.trace_id')
TOOL_CALL_ID=$(echo "$GEN_RESPONSE" | jq -r '.required_action.tool_calls[0].id')
```

</TabItem>
</Tabs>

The response looks like this:

```json
{
  "status": "requires_action",
  "required_action": {
    "type": "submit_tool_outputs",
    "tool_calls": [
      {
        "id": "call_tohrsiy1",
        "tool_name": "get_order_status",
        "args": { "orderId": "ord_1042" }
      }
    ]
  }
}
```

:::note
Running against local Ollama and got `"status": "completed"` with `required_action: null`? That is the ignored `tool_choice` described in Step 5 — the model chose to answer instead of calling the function. Re-run the generation, or point the agent at a provider that honors forcing.
:::

Nothing is executing anywhere at this point. The generation is suspended server-side, waiting for your app — this is also the seam where a human can review the call before anything happens (see [Approvals](/docs/modules/approvals)).

---

## Step 7 — Execute the function in your app and submit the output

Your application runs the real function and posts the result back with the matching `tool_call_id`. The `output` can be any JSON value; the agent resumes with the tool result in context. See [Tools — client](/docs/modules/tools#client) for the full flow.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Your app executes the function — here, a lookup in the store's database.
ORDER_RESULT='{"orderId":"ord_1042","status":"shipped","carrier":"DHL","eta":"2026-08-02"}'

# Small local models occasionally emit raw control characters in the final
# text; strip them so jq can parse the response.
FINAL_RESPONSE=$(soat submit-agent-tool-outputs \
  --agent-id "$AGENT_ID" \
  --generation-id "$GEN_ID" \
  --tool-outputs '[{"tool_call_id":"'"$TOOL_CALL_ID"'","output":'"$ORDER_RESULT"'}]' | LC_ALL=C tr -d '\000-\037')

echo "$FINAL_RESPONSE" | jq '{status, content: .output.content}'
echo "$FINAL_RESPONSE" | jq -e '.status == "completed"' > /dev/null
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Your app executes the function — here, a lookup in the store's database.
const orderResult = {
  orderId: 'ord_1042',
  status: 'shipped',
  carrier: 'DHL',
  eta: '2026-08-02',
};

const { data: final } = await adminSoat.agents.submitAgentToolOutputs({
  path: { agent_id: agentId, generation_id: generation!.id },
  body: {
    tool_outputs: [{ tool_call_id: toolCall.id, output: orderResult }],
  },
});

console.log(final!.status); // "completed"
console.log(final!.output!.content); // "Order ord_1042 has shipped via DHL..."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORDER_RESULT='{"orderId":"ord_1042","status":"shipped","carrier":"DHL","eta":"2026-08-02"}'

FINAL_RESPONSE=$(curl -s -X POST \
  "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate/$GEN_ID/tool-outputs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool_outputs":[{"tool_call_id":"'"$TOOL_CALL_ID"'","output":'"$ORDER_RESULT"'}]}' | LC_ALL=C tr -d '\000-\037')

echo "$FINAL_RESPONSE" | jq '{status, content: .output.content}'
```

</TabItem>
</Tabs>

The status flips to `completed` and `output.content` holds the assistant's answer, grounded in the data your app supplied:

```json
{
  "status": "completed",
  "content": "The order ord_1042 has been marked as shipped. The carrier is DHL and the delivery date is August 2, 2026."
}
```

If the model had requested several client calls in one step, `tool_calls` would contain one entry per call and you would submit all outputs in a single `tool_outputs` array.

---

## Step 8 — Inspect the pause and resume in the trace

Every generation writes a [trace](/docs/modules/traces#examples). For a client-tool run it records the whole exchange — the forced tool call, your submitted output, and the final text. `step_count` covers both halves of the run, and `file_id` points to the [file](/docs/modules/files) holding the full serialized steps.

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

```json
{
  "id": "trace_Yhm0QlF6MOa67Z0v",
  "agent_id": "agent_AbpwfxbwiiweroDR",
  "step_count": 2,
  "file_id": "file_L0SMZw81UH0aZXnQ"
}
```

Two steps: the model call that proposed `get_order_status`, and the resumed call that turned your output into the answer.

---

## Where to go next

- **Sessions** — the same pause-and-resume loop works in long-lived [sessions](/docs/modules/sessions): `generate-session-response --wait true` returns `requires_action` and `submit-session-tool-outputs` resumes it, with SOAT keeping the conversation history for you.
- **Gate the call before it reaches your app** — attach a [guardrail](/docs/modules/guardrails) to classify each client call, or require human sign-off with [approvals](/docs/modules/approvals). See [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- **Reshape the output** — [`output_mapping`](/docs/modules/tools#output-mapping) applies a JSON Logic transform to the output your app submits before the model sees it.
- **Track spend per end user** — attribute each session's generations to an [actor](/docs/modules/actors) and cap budgets: [Cap Spend Per End User](/docs/tutorials/cap-spend-per-end-user).
