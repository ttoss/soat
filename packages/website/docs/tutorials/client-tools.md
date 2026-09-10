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

A [client tool](/docs/modules/tools#client) declares a function's contract; SOAT never executes it. The generation pauses with `requires_action`, hands the tool calls to your app, and resumes when you submit the results — the function-calling loop of the OpenAI and Anthropic APIs, with configuration, history and traces server-side.

You build an order-support agent whose `get_order_status` function is a client tool.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [Ollama](https://ollama.com) at `http://ollama:11434` with `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl; server at `http://localhost:5047`.

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

Every resource lives inside a [project](/docs/modules/projects#examples).

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

A local Ollama [AI provider](/docs/modules/ai-providers#examples). Other providers: [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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

A [client tool](/docs/modules/tools#client) has a `name`, a `description` and a JSON Schema in `parameters`, with no `execute` configuration. The model sees the schema as written; parameter keys come back to your app exactly as authored (`orderId` stays `orderId`).

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

Attach the tool through [`tool_bindings`](/docs/modules/agents#tool-bindings). Three settings make the loop predictable:

- [`step_rules`](/docs/modules/agents#step-rules) `{ "step": 1, "tool_choice": { "type": "tool", "tool_name": "get_order_status" } }` forces the first call of the turn. Step numbering spans the pause, so the step after you submit the output is step 2 and free to answer. Agent-level [`tool_choice`](/docs/modules/agents#tool-choice) would apply to every step, the resumed one included, re-proposing the tool on each submit until `max_steps`.

  Forcing is passed through to the provider. [Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) ignores `tool_choice`, so a local Ollama agent falls back to `"auto"`; OpenAI, Anthropic and xAI honor it.
- [`stop_conditions`](/docs/modules/agents#stop-conditions) `{ "type": "has_tool_call", "tool_name": "get_order_status" }` names the call that ends the turn. Required only when the agent's own `tool_choice` forces a tool; here it documents the intended exit.
- `max_steps` is counted across the pause: the resumed turn spends what is left.

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

Start a generation as for any [agent](/docs/modules/agents#examples). The response comes back with `status: "requires_action"`; each `required_action.tool_calls` entry has an `id`, the `tool_name` and the model-supplied `args`.

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

Response:

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
`"status": "completed"` with `required_action: null` on local Ollama is the ignored `tool_choice` from Step 5. Re-run, or use a provider that honors forcing.
:::

The generation is suspended server-side; this is also where a human can review the call ([Approvals](/docs/modules/approvals)).

---

## Step 7 — Execute the function in your app and submit the output

Post the result back with the matching `tool_call_id`; `output` is any JSON value. See [Tools — client](/docs/modules/tools#client).

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

Status is `completed` and `output.content` holds the answer:

```json
{
  "status": "completed",
  "content": "The order ord_1042 has been marked as shipped. The carrier is DHL and the delivery date is August 2, 2026."
}
```

Several client calls in one step yield one `tool_calls` entry each; submit all outputs in a single `tool_outputs` array.

---

## Step 8 — Inspect the pause and resume in the trace

Every generation writes a [trace](/docs/modules/traces#examples) recording the forced tool call, your submitted output and the final text. `step_count` covers both halves; `file_id` points to the [file](/docs/modules/files) with the serialized steps.

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

Two steps: the call that proposed `get_order_status`, and the resumed call that produced the answer.

---

## Where to go next

- [Sessions](/docs/modules/sessions) — `generate-session-response --wait true` returns `requires_action`; `submit-session-tool-outputs` resumes it.
- Gate the call with a [guardrail](/docs/modules/guardrails) or [approvals](/docs/modules/approvals): [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- [`output_mapping`](/docs/modules/tools#output-mapping) — JSON Logic transform on the submitted output before the model sees it.
- Attribute generations to an [actor](/docs/modules/actors): [Cap Spend Per End User](/docs/tutorials/cap-spend-per-end-user).
