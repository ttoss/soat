---
description: 'Hand a per-user credential to an orchestration run with tool_context, land it as a real Authorization header with a {{context:...}} token, and confine it to one tool with context_keys.'
keywords:
  - tool context
  - per-user credentials
  - orchestration run
  - Authorization header
  - context_keys
  - credential containment
sidebar_position: 21
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Pass Per-User Credentials to Tools with Tool Context

A scheduled or orchestrated flow often acts *on behalf of a user*: the tools a run's agents call must authenticate as that user, not as the platform. [`tool_context`](/docs/advanced/tool-context) is the channel for that — a flat key/value bag attached to the run, forwarded as request headers on every tool call.

You will:

1. Create an `http` tool whose `Authorization` header is a [`{{context:userToken}}`](/docs/advanced/expressions-and-templating#context-references-context) token, confined with [`context_keys`](/docs/modules/tools#scoping-which-context-keys-reach-a-tool).
2. Start an [orchestration run](/docs/modules/orchestrations#run-tool-context) with a `tool_context`, pause at a human node, and resume.
3. Inspect the exact headers that reached the endpoint, and see the fail-closed `MISSING_TOOL_CONTEXT_KEY` path.

The tool endpoint is a local header-echo listener, so no external services are needed beyond Ollama.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, tools, and runs first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- [Ollama](https://ollama.com) reachable by the server with the `qwen2.5:0.5b` model pulled, as in the [orchestration tutorial](/docs/tutorials/orchestrate-a-sonnet).
- Server is at `http://localhost:5047`.

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
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Everything in this tutorial lives inside one [project](/docs/modules/projects).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "tool-context-tutorial" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'tool-context-tutorial' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "tool-context-tutorial"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an AI provider

Set up a local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama, so the tutorial runs without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Start a header-echo endpoint

The tool needs somewhere to call, and the whole point of this tutorial is to inspect **exactly which headers arrive there**. Start a tiny local HTTP listener that writes the headers of the last request it received to `tool-echo.json`.

In the automated tutorial tests, `SOAT_TOOL_ECHO_BASE_URL` is injected so the server container can reach this listener — the same mechanism the [webhooks tutorial](/docs/tutorials/chat-with-llm) uses for its own listener. Running the SOAT server in Docker against a listener on your host? Use `http://host.docker.internal:8788` as the base instead of `localhost`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ECHO_URL="${SOAT_TOOL_ECHO_BASE_URL:-http://localhost:8788}/orders"

node -e '
const http = require("http");
const fs = require("fs");
http
  .createServer((req, res) => {
    if (req.method === "POST") {
      fs.writeFileSync("tool-echo.json", JSON.stringify({ headers: req.headers }));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(8788);
' > echo-listener.log 2>&1 &
ECHO_PID=$!
echo "Echo listener PID: $ECHO_PID"

# → retry 10
node -e 'require("http").get("http://localhost:8788/health", (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))'
```

The readiness probe is a `GET`, and the listener only records `POST` bodies — so probing never overwrites the header record the assertions in Step 10 read.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const ECHO_URL = `${process.env.SOAT_TOOL_ECHO_BASE_URL ?? 'http://localhost:8788'}/orders`;

createServer((req, res) => {
  if (req.method === 'POST') {
    writeFileSync('tool-echo.json', JSON.stringify({ headers: req.headers }));
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}).listen(8788);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ECHO_URL="${SOAT_TOOL_ECHO_BASE_URL:-http://localhost:8788}/orders"

node -e '
const http = require("http");
const fs = require("fs");
http
  .createServer((req, res) => {
    if (req.method === "POST") {
      fs.writeFileSync("tool-echo.json", JSON.stringify({ headers: req.headers }));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(8788);
' > echo-listener.log 2>&1 &
ECHO_PID=$!
```

</TabItem>
</Tabs>

---

## Step 5 — Create the tool: a `{{context:...}}` header plus a `context_keys` allowlist

This one [tool definition](/docs/modules/tools#examples) carries both halves of the credential story:

- **`Authorization: Bearer {{context:userToken}}`** — a [context reference](/docs/advanced/expressions-and-templating#context-references-context): at call time the server substitutes the `userToken` key of the run's `tool_context` into this header.
- **`context_keys: ["tenant"]`** — the [containment allowlist](/docs/modules/tools#scoping-which-context-keys-reach-a-tool): only `tenant` is forwarded as a prefixed `X-Soat-Context-*` header, so the raw `userToken` context header is never sent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORDER_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "record_order" \
  --type "http" \
  --description "Records an order for the signed-in user" \
  --parameters '{"type":"object","properties":{"note":{"type":"string","description":"Free-text note for the order"}}}' \
  --execute '{"url":"'"$ECHO_URL"'","method":"POST","headers":{"Authorization":"Bearer {{context:userToken}}"}}' \
  --context-keys '["tenant"]' | jq -r '.id')
echo "ORDER_TOOL_ID: $ORDER_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orderTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'record_order',
    type: 'http',
    description: 'Records an order for the signed-in user',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Free-text note for the order' },
      },
    },
    execute: {
      url: ECHO_URL,
      method: 'POST',
      headers: { Authorization: 'Bearer {{context:userToken}}' },
    },
    context_keys: ['tenant'],
  },
});
const ORDER_TOOL_ID = orderTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORDER_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"record_order\",\"type\":\"http\",\"description\":\"Records an order for the signed-in user\",\"parameters\":{\"type\":\"object\",\"properties\":{\"note\":{\"type\":\"string\",\"description\":\"Free-text note for the order\"}}},\"execute\":{\"url\":\"$ECHO_URL\",\"method\":\"POST\",\"headers\":{\"Authorization\":\"Bearer {{context:userToken}}\"}},\"context_keys\":[\"tenant\"]}" \
  | jq -r '.id')
echo "ORDER_TOOL_ID: $ORDER_TOOL_ID"
```

</TabItem>
</Tabs>

The token is resolved at the point of use, never at rest: reading the tool back returns the literal template, exactly like a [`{{secret:...}}`](/docs/advanced/expressions-and-templating) reference.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-tool --tool-id "$ORDER_TOOL_ID" | jq -e '.execute.headers.Authorization == "Bearer {{context:userToken}}"'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: readBack } = await adminSoat.tools.getTool({
  path: { tool_id: ORDER_TOOL_ID },
});
console.log(readBack.execute?.headers?.Authorization);
// "Bearer {{context:userToken}}" — the template, never a resolved value
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/tools/$ORDER_TOOL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -e '.execute.headers.Authorization == "Bearer {{context:userToken}}"'
```

</TabItem>
</Tabs>

:::note[Why not put the token in `tool_context` under the key `Authorization`?]

A `tool_context` key always lands under the context prefix, so a caller-supplied key can never name (or overwrite) a standard header. See [Placing a value in a real header](/docs/advanced/tool-context#placing-a-value-in-a-real-header).

:::

---

## Step 6 — Create the agent

A small agent that carries the tool. A step-1 [`step_rules`](/docs/modules/agents) entry forces the first model call to invoke `record_order`, so the tool call — the thing this tutorial asserts on — does not depend on what a small local model feels like doing. See [client tools](/docs/tutorials/client-tools#step-5--create-the-agent) for the forcing semantics.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Order Clerk" \
  --instructions "You record orders. Call the record_order tool exactly once, then reply with a one-line confirmation. Never ask follow-up questions." \
  --tool-ids "[\"$ORDER_TOOL_ID\"]" \
  --step-rules '[{"step":1,"tool_choice":{"type":"tool","tool_name":"record_order"}}]' \
  --max-steps 3 | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Order Clerk',
    instructions:
      'You record orders. Call the record_order tool exactly once, then reply with a one-line confirmation. Never ask follow-up questions.',
    tool_ids: [ORDER_TOOL_ID],
    step_rules: [
      { step: 1, tool_choice: { type: 'tool', tool_name: 'record_order' } },
    ],
    max_steps: 3,
  },
});
const AGENT_ID = agent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Order Clerk\",\"instructions\":\"You record orders. Call the record_order tool exactly once, then reply with a one-line confirmation. Never ask follow-up questions.\",\"tool_ids\":[\"$ORDER_TOOL_ID\"],\"step_rules\":[{\"step\":1,\"tool_choice\":{\"type\":\"tool\",\"tool_name\":\"record_order\"}}],\"max_steps\":3}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Create the orchestration: a pause before the tool call

Two nodes: a [`human` node](/docs/modules/orchestrations#human-nodes) that parks the run, then the `agent` node that makes the tool call. A paused run has no request in flight that could carry a `tool_context`, so resuming with the bag intact proves it is stored on the run itself ([Run Tool Context](/docs/modules/orchestrations#run-tool-context)). The token appears nowhere in the graph — the graph is reusable for every user; the credential arrives per run.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCHESTRATION_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Record Order For User" \
  --nodes '[
    {"id":"confirm","type":"human","prompt":"Proceed with recording the order?","options":["proceed","cancel"]},
    {"id":"record","type":"agent","agent_id":"'"$AGENT_ID"'","prompt":"Record order #1234 for the signed-in user."}
  ]' \
  --edges '[{"from":"confirm","to":"record"}]' | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestration } = await adminSoat.orchestrations.createOrchestration({
  body: {
    project_id: PROJECT_ID,
    name: 'Record Order For User',
    nodes: [
      {
        id: 'confirm',
        type: 'human',
        prompt: 'Proceed with recording the order?',
        options: ['proceed', 'cancel'],
      },
      {
        id: 'record',
        type: 'agent',
        agent_id: AGENT_ID,
        prompt: 'Record order #1234 for the signed-in user.',
      },
    ],
    edges: [{ from: 'confirm', to: 'record' }],
  },
});
const ORCHESTRATION_ID = orchestration.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCHESTRATION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Record Order For User\",\"nodes\":[{\"id\":\"confirm\",\"type\":\"human\",\"prompt\":\"Proceed with recording the order?\",\"options\":[\"proceed\",\"cancel\"]},{\"id\":\"record\",\"type\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"prompt\":\"Record order #1234 for the signed-in user.\"}],\"edges\":[{\"from\":\"confirm\",\"to\":\"record\"}]}" \
  | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Start the run with the user's credential

Pass `tool_context` when starting the run ([Run Tool Context](/docs/modules/orchestrations#run-tool-context)). In production the caller is whoever holds the per-user token. With `--wait`, the call returns as soon as the run parks at the `confirm` node.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN=$(soat start-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --input '{}' \
  --tool-context '{"userToken":"alice-token-123","tenant":"acme"}' \
  --wait)

RUN_ID=$(printf '%s' "$RUN" | jq -r '.id')
printf '%s\n' "$RUN" | jq '{status, required_action}'
printf '%s' "$RUN" | jq -e '.status == "awaiting_input"'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCHESTRATION_ID,
    input: {},
    tool_context: { userToken: 'alice-token-123', tenant: 'acme' },
    wait: true,
  },
});
const RUN_ID = run.id;
console.log(run.status); // "awaiting_input"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{},\"tool_context\":{\"userToken\":\"alice-token-123\",\"tenant\":\"acme\"},\"wait\":true}")

RUN_ID=$(printf '%s' "$RUN" | jq -r '.id')
printf '%s\n' "$RUN" | jq '{status, required_action}'
```

</TabItem>
</Tabs>

Expected output — the run is parked, holding the bag, with no generation started yet:

```json
{
  "status": "awaiting_input",
  "required_action": {
    "type": "human_input",
    "node_id": "confirm",
    "prompt": "Proceed with recording the order?",
    "options": ["proceed", "cancel"]
  }
}
```

---

## Step 9 — Resume, and let the tool call happen

Submit the human decision with [`submit-human-input`](/docs/modules/orchestrations#human-nodes). The resume request carries **no `tool_context` of its own** — the run re-reads the bag it stored at start. The `record` agent node then runs: the model is forced to call `record_order`, and the server builds the outbound request — substituting `{{context:userToken}}` into `Authorization` and forwarding the allowlisted `tenant` key as a context header.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat submit-human-input \
  --orchestration-run-id "$RUN_ID" \
  --node-id "confirm" \
  --output '{"choice":"proceed"}' | jq '{status}'

# → retry 120
soat get-orchestration-run --orchestration-run-id "$RUN_ID" | jq -e '.status == "succeeded"'

soat get-orchestration-run --orchestration-run-id "$RUN_ID" \
  | jq '[.node_executions[] | {node_id, node_type, status}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.orchestrations.submitHumanInput({
  path: { orchestration_run_id: RUN_ID },
  body: { node_id: 'confirm', output: { choice: 'proceed' } },
});

// Poll until the run settles
let finished;
do {
  await new Promise((r) => setTimeout(r, 1000));
  ({ data: finished } = await adminSoat.orchestrations.getOrchestrationRun({
    path: { orchestration_id: ORCHESTRATION_ID, orchestration_run_id: RUN_ID },
  }));
} while (!['succeeded', 'failed'].includes(finished.status));
console.log(finished.status); // "succeeded"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN_ID/human-input" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"node_id":"confirm","output":{"choice":"proceed"}}' | jq '{status}'

curl -s "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status}'
```

</TabItem>
</Tabs>

---

## Step 10 — Inspect what actually reached the endpoint

The echo listener recorded the headers of the tool call. Three assertions, one per guarantee:

1. **The credential arrived in the real header** — `Authorization: Bearer alice-token-123`, substituted from the run's `tool_context` by the tool's `{{context:userToken}}` token.
2. **The allowlisted key arrived as a context header** — `x-soat-context-tenant: acme`. (Header names arrive lowercased; [read them case-insensitively](/docs/advanced/tool-context#read-the-header-case-insensitively).)
3. **The raw token did not** — no `x-soat-context-usertoken` header, because `context_keys: ["tenant"]` does not list it. The credential exists at this endpoint only where the tool declared it, and would not reach any other tool at all.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
jq '.headers | {authorization, "x-soat-context-tenant": .["x-soat-context-tenant"]}' tool-echo.json

jq -e '.headers.authorization == "Bearer alice-token-123"' tool-echo.json
jq -e '.headers["x-soat-context-tenant"] == "acme"' tool-echo.json
jq -e '.headers | has("x-soat-context-usertoken") | not' tool-echo.json
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { readFileSync } from 'node:fs';

const { headers } = JSON.parse(readFileSync('tool-echo.json', 'utf8'));

console.log(headers['authorization']); // "Bearer alice-token-123"
console.log(headers['x-soat-context-tenant']); // "acme"
console.log('x-soat-context-usertoken' in headers); // false — contained
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
jq '.headers | {authorization, "x-soat-context-tenant": .["x-soat-context-tenant"]}' tool-echo.json
```

</TabItem>
</Tabs>

Expected output:

```json
{
  "authorization": "Bearer alice-token-123",
  "x-soat-context-tenant": "acme"
}
```

:::tip[Self-hosting under your own brand?]

The `X-Soat-Context-` prefix is deployment configuration: set [`TOOL_CONTEXT_HEADER_PREFIX`](/docs/advanced/tool-context#configuring-the-header-prefix) (e.g. `X-Acme-Context-`) and every context header is emitted under your name instead. The `{{context:...}}` mechanism is unaffected — it never uses the prefix.

:::

---

## Step 11 — The fail-closed path: a call with no context at all

When substitution has no `userToken` to resolve, the tool call **fails** with `MISSING_TOOL_CONTEXT_KEY` — naming the key and the header — instead of sending an empty `Authorization: Bearer `. The shortest way to see it is [`call-tool`](/docs/modules/tools#examples), which invokes a tool directly with no run behind it and therefore no `tool_context` (an orchestration `tool` node behaves the same — see the [rules table](/docs/advanced/tool-context#placing-a-value-in-a-real-header)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat call-tool --tool-id "$ORDER_TOOL_ID" --input '{"note":"direct call"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await adminSoat.tools.callTool({
  path: { tool_id: ORDER_TOOL_ID },
  body: { input: { note: 'direct call' } },
});
console.log(error?.error?.code); // "MISSING_TOOL_CONTEXT_KEY"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tools/$ORDER_TOOL_ID/call" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"note":"direct call"}}' | jq '.error.code'
```

</TabItem>
</Tabs>

Expected output — the call is refused before anything reaches the endpoint:

```json
"MISSING_TOOL_CONTEXT_KEY"
```

A tool that declares a `{{context:...}}` token must therefore be reached through a path that carries context: an agent generation, a session, or an orchestration `agent` node — as in Steps 8 and 9.

---

## Step 12 — Clean up

Stop the [Node.js](https://nodejs.org) echo listener from Step 4.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → ignore
kill $ECHO_PID
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Close the createServer() instance from Step 4, e.g. server.close()
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# → ignore
kill $ECHO_PID
```

</TabItem>
</Tabs>

---

## Where to go next

- [Tool Context](/docs/advanced/tool-context) — the canonical contract and security notes.
- [Expressions & Templating](/docs/advanced/expressions-and-templating) — how `{{context:...}}` and `{{secret:...}}` compose.
- [Run Tool Context](/docs/modules/orchestrations#run-tool-context) — why the bag survives every way a run is driven.
- [Cap spend per end user](/docs/tutorials/cap-spend-per-end-user) — sessions and actors, where identity keys in `tool_context` are auto-populated.
