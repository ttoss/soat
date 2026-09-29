---
description: 'Grade an agent that returns structured output: an output_schema scorer for shape, a json_logic scorer over item metadata for correctness, and a business rule in your own code as a tool scorer, read per kind and measured against a baseline.'
keywords:
  - custom eval scorer
  - structured output evaluation
  - output schema scorer
  - tool scorer
  - evaluation metadata
sidebar_position: 30
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Grade Structured Output with Your Own Scorer

An agent that returns an object is right when the object has the right shape, the right values, and obeys rules only your systems know. Three [scorers](/docs/modules/evaluations#scorers) check one each: `output_schema` for shape, `json_logic` against each item's `metadata` for values, and a `tool` scorer running your own code for the rule. Build a refund-triage suite, read its pass rate per kind of request, fix the agent, and measure the fix against the first run.

Assumes [Evaluate an Agent](/docs/tutorials/evaluate-an-agent).

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- `TOOL_EGRESS_ALLOWED_HOSTS=localhost:8789` on the server, so a tool may call the local scorer service ([Configuration — Outbound Egress](/docs/self-hosting/configuration#outbound-egress)).
- [Ollama](https://ollama.com) with `qwen2.5:0.5b`. For xAI, OpenAI, Anthropic, or Amazon Bedrock see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- [CLI](/docs/cli) or [SDK](/docs/sdk), and [Node.js](https://nodejs.org) for the scorer service.

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

See [Users](/docs/modules/users#examples).

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

## Step 2 — An agent that returns an object

The agent classifies a customer message as `refund` or `question` and reads the amount asked for. Its `output_schema` constrains the model; the parsed object is what the scorers read as `object` ([Agents — Structured Output](/docs/modules/agents#structured-output)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Refund Scoring" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Refund Triage" \
  --instructions "Classify the customer message. category is refund when the customer asks for money back, otherwise question. refund_amount is the amount the customer asks for, or 0." \
  --output-schema '{"type":"object","required":["category","refund_amount"],"properties":{"category":{"type":"string","enum":["refund","question"]},"refund_amount":{"type":"number"}}}' | jq -r '.id')

echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Refund Scoring' },
});

const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: project.id,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: project.id,
    ai_provider_id: provider.id,
    name: 'Refund Triage',
    instructions:
      'Classify the customer message. category is refund when the customer asks for money back, otherwise question. ' +
      'refund_amount is the amount the customer asks for, or 0.',
    output_schema: {
      type: 'object',
      required: ['category', 'refund_amount'],
      properties: {
        category: { type: 'string', enum: ['refund', 'question'] },
        refund_amount: { type: 'number' },
      },
    },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Refund Scoring"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Refund Triage\",\"instructions\":\"Classify the customer message. category is refund when the customer asks for money back, otherwise question. refund_amount is the amount the customer asks for, or 0.\",\"output_schema\":{\"type\":\"object\",\"required\":[\"category\",\"refund_amount\"],\"properties\":{\"category\":{\"type\":\"string\",\"enum\":[\"refund\",\"question\"]},\"refund_amount\":{\"type\":\"number\"}}}}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Write the scorer service

The business rule: a refund never exceeds what the customer paid. The price lives in your order system, not in the model's output, so the check is your code. The engine sends it `{ input, output, object, expected, item }` and expects `{ score, passed?, reasoning? }` back ([Evaluations — Custom scorers](/docs/modules/evaluations#custom-scorers-tool)).

The automated tutorial tests inject `SOAT_SCORER_BASE_URL` so the server container can reach the service. With the SOAT server in Docker and the service on the host, use `http://host.docker.internal:8789` instead of `localhost`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SCORER_URL="${SOAT_SCORER_BASE_URL:-http://localhost:8789}/score"

node -e '
const http = require("http");
const grade = ({ object, item }) => {
  if (object.category !== "refund") return { score: 1, passed: true, reasoning: "Not a refund." };
  const paid = item.metadata.order_total;
  const ok = object.refund_amount <= paid;
  return { score: ok ? 1 : 0, passed: ok, reasoning: "Refund " + object.refund_amount + " against " + paid + " paid." };
};
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") return res.end("{}");
      try {
        res.end(JSON.stringify(grade(JSON.parse(body))));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  })
  .listen(8789);
' > refund-scorer.log 2>&1 &
SCORER_PID=$!
echo "Scorer PID: $SCORER_PID"

# → retry 10
node -e 'require("http").get("http://localhost:8789/health", (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { createServer } from 'node:http';

const SCORER_URL = `${process.env.SOAT_SCORER_BASE_URL ?? 'http://localhost:8789'}/score`;

type ScorerInput = {
  object: { category: string; refund_amount: number };
  item: { metadata: { order_total: number } };
};

const grade = ({ object, item }: ScorerInput) => {
  if (object.category !== 'refund') {
    return { score: 1, passed: true, reasoning: 'Not a refund.' };
  }
  const paid = item.metadata.order_total;
  const ok = object.refund_amount <= paid;
  return {
    score: ok ? 1 : 0,
    passed: ok,
    reasoning: `Refund ${object.refund_amount} against ${paid} paid.`,
  };
};

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.end('{}');
    try {
      res.end(JSON.stringify(grade(JSON.parse(body))));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
}).listen(8789);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SCORER_URL="${SOAT_SCORER_BASE_URL:-http://localhost:8789}/score"

node -e '
const http = require("http");
const grade = ({ object, item }) => {
  if (object.category !== "refund") return { score: 1, passed: true, reasoning: "Not a refund." };
  const paid = item.metadata.order_total;
  const ok = object.refund_amount <= paid;
  return { score: ok ? 1 : 0, passed: ok, reasoning: "Refund " + object.refund_amount + " against " + paid + " paid." };
};
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") return res.end("{}");
      try {
        res.end(JSON.stringify(grade(JSON.parse(body))));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  })
  .listen(8789);
' > refund-scorer.log 2>&1 &
```

</TabItem>
</Tabs>

---

## Step 4 — Register it as a tool

An `http` tool sends its arguments as the JSON body of a `POST` ([Tools — http](/docs/modules/tools#http)). Calling it directly with a refund above the price paid shows the verdict the eval will record ([Tools — Calling a Tool Directly](/docs/modules/tools#calling-a-tool-directly)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SCORER_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "refund-policy" \
  --type http \
  --description "Checks a refund against the price paid" \
  --execute '{"url":"'"$SCORER_URL"'","method":"POST"}' | jq -r '.id')

soat call-tool --tool-id "$SCORER_TOOL_ID" \
  --input '{"object":{"category":"refund","refund_amount":60},"item":{"metadata":{"order_total":25}}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: scorerTool } = await adminSoat.tools.createTool({
  body: {
    project_id: project.id,
    name: 'refund-policy',
    type: 'http',
    description: 'Checks a refund against the price paid',
    execute: { url: SCORER_URL, method: 'POST' },
  },
});

const { data: verdict } = await adminSoat.tools.callTool({
  path: { tool_id: scorerTool.id },
  body: {
    input: {
      object: { category: 'refund', refund_amount: 60 },
      item: { metadata: { order_total: 25 } },
    },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SCORER_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"refund-policy\",\"type\":\"http\",\"description\":\"Checks a refund against the price paid\",\"execute\":{\"url\":\"$SCORER_URL\",\"method\":\"POST\"}}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/tools/$SCORER_TOOL_ID/call" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"object":{"category":"refund","refund_amount":60},"item":{"metadata":{"order_total":25}}}}'
```

</TabItem>
</Tabs>

```json
{ "score": 0, "passed": false, "reasoning": "Refund 60 against 25 paid." }
```

---

## Step 5 — A dataset labelled by kind

Each item's `metadata` carries its `kind`, the category it should get, and the price paid. Scorers read it as `item.metadata`; the price never reaches the agent ([Eval Design — Label each item's kind](/docs/advanced/eval-design#label-each-items-kind)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DATASET_ID=$(soat create-dataset --project-id "$PROJECT_ID" --name "refund-requests" | jq -r '.id')

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"Order 1042 cost $40 and arrived broken. Please refund the $40."}]' \
  --metadata '{"kind":"refund","expected_category":"refund","order_total":40}' | jq -r '.id'

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"I paid $25 for order 1182 and it was late. Refund me $60 for the trouble."}]' \
  --metadata '{"kind":"refund","expected_category":"refund","order_total":25}' | jq -r '.id'

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"Do you ship to Canada?"}]' \
  --metadata '{"kind":"question","expected_category":"question","order_total":0}' | jq -r '.id'

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"How long does delivery take?"}]' \
  --metadata '{"kind":"question","expected_category":"question","order_total":0}' | jq -r '.id'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: dataset } = await adminSoat.evaluations.createDataset({
  body: { project_id: project.id, name: 'refund-requests' },
});

const cases = [
  { message: 'Order 1042 cost $40 and arrived broken. Please refund the $40.', kind: 'refund', paid: 40 },
  { message: 'I paid $25 for order 1182 and it was late. Refund me $60 for the trouble.', kind: 'refund', paid: 25 },
  { message: 'Do you ship to Canada?', kind: 'question', paid: 0 },
  { message: 'How long does delivery take?', kind: 'question', paid: 0 },
];

for (const testCase of cases) {
  await adminSoat.evaluations.createDatasetItem({
    path: { dataset_id: dataset.id },
    body: {
      input: [{ role: 'user', content: testCase.message }],
      metadata: {
        kind: testCase.kind,
        expected_category: testCase.kind,
        order_total: testCase.paid,
      },
    },
  });
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DATASET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"refund-requests\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":[{"role":"user","content":"I paid $25 for order 1182 and it was late. Refund me $60 for the trouble."}],"metadata":{"kind":"refund","expected_category":"refund","order_total":25}}' | jq -r '.id'
```

</TabItem>
</Tabs>

No item carries an `expected_output`: every scorer here grades the object, not a reference string.

---

## Step 6 — Bind three scorers

| Scorer | Asks |
| --- | --- |
| `output_schema` | Is the object well formed? Its own `schema` adds `minimum: 0`, stricter than the agent's |
| `json_logic` | Is `category` the one the item's `metadata` expects? |
| `tool` (`refund-policy`) | Does the refund stay within the price paid? |

An item passes only when all three pass ([Evaluations — Pass semantics](/docs/modules/evaluations#pass-semantics)). The `tool` scorer's own `passed` decides its verdict, so it needs no `pass_threshold`. `group_by: kind` rolls every run up per `metadata.kind` too ([Evaluations — Grouped aggregates](/docs/modules/evaluations#grouped-aggregates)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
EVAL_ID=$(soat create-eval \
  --project-id "$PROJECT_ID" \
  --name "refund-triage" \
  --agent-id "$AGENT_ID" \
  --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"output_schema","schema":{"type":"object","properties":{"refund_amount":{"type":"number","minimum":0}}}},{"type":"json_logic","expression":{"==":[{"var":"object.category"},{"var":"item.metadata.expected_category"}]}},{"type":"tool","name":"refund-policy","tool_id":"'"$SCORER_TOOL_ID"'"}]' \
  --pass-threshold 0.75 \
  --group-by kind | jq -r '.id')

soat get-eval --eval-id "$EVAL_ID" | jq '{scorers: .scorers | map(.name // .type), group_by}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: evaluation } = await adminSoat.evaluations.createEval({
  body: {
    project_id: project.id,
    name: 'refund-triage',
    agent_id: agent.id,
    dataset_id: dataset.id,
    scorers: [
      {
        type: 'output_schema',
        schema: {
          type: 'object',
          properties: { refund_amount: { type: 'number', minimum: 0 } },
        },
      },
      {
        type: 'json_logic',
        expression: {
          '==': [{ var: 'object.category' }, { var: 'item.metadata.expected_category' }],
        },
      },
      { type: 'tool', name: 'refund-policy', tool_id: scorerTool.id },
    ],
    pass_threshold: 0.75,
    group_by: 'kind',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
EVAL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"refund-triage\",\"agent_id\":\"$AGENT_ID\",\"dataset_id\":\"$DATASET_ID\",\"scorers\":[{\"type\":\"output_schema\",\"schema\":{\"type\":\"object\",\"properties\":{\"refund_amount\":{\"type\":\"number\",\"minimum\":0}}}},{\"type\":\"json_logic\",\"expression\":{\"==\":[{\"var\":\"object.category\"},{\"var\":\"item.metadata.expected_category\"}]}},{\"type\":\"tool\",\"name\":\"refund-policy\",\"tool_id\":\"$SCORER_TOOL_ID\"}],\"pass_threshold\":0.75,\"group_by\":\"kind\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 7 — Run it and read each scorer

The run is queued and polled to `completed`: four real generations plus a tool call per item can outlast one HTTP request ([Sync and Async](/docs/advanced/sync-and-async)). Outcomes and aggregates key on the scorer type, or on `name` for a `tool` scorer. The tool's `reasoning` is stored on the result.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
BASELINE_RUN_ID=$(soat start-eval-run --eval-id "$EVAL_ID" --wait false | jq -r '.id')

# → retry 300
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" | jq -e '.status == "completed"'

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq '{passed, completed_count, errored_count, scorers: .aggregate_scores.scorers}'

soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq '.data | map({output, error, scores: [.scores[]? | {scorer, passed, reasoning}]})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const settle = async (runId: string) => {
  for (;;) {
    const { data } = await adminSoat.evaluations.getEvalRun({
      path: { eval_id: evaluation.id, eval_run_id: runId },
    });
    if (data.status !== 'queued' && data.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

const { data: queuedBaseline } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: false },
});
const baselineRun = await settle(queuedBaseline.id);

const { data: results } = await adminSoat.evaluations.listEvalResults({
  path: { eval_id: evaluation.id, eval_run_id: baselineRun.id },
});

for (const result of results.data) {
  console.log(result.output, result.error, result.scores);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
BASELINE_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":false}' | jq -r '.id')

until curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '.status == "completed"' >/dev/null; do
  sleep 2
done

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID/results" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data | map({output, error, scores: [.scores[]? | {scorer, passed, reasoning}]})'
```

</TabItem>
</Tabs>

The over-limit request, read as asked:

```json
{
  "output": "{\"category\":\"refund\",\"refund_amount\":60}",
  "error": null,
  "scores": [
    { "scorer": "output_schema", "passed": true, "reasoning": null },
    { "scorer": "json_logic", "passed": true, "reasoning": null },
    { "scorer": "refund-policy", "passed": false, "reasoning": "Refund 60 against 25 paid." }
  ]
}
```

A well-formed, correctly classified object still fails: only your rule knew the price. An object that breaks the agent's own `output_schema` fails the generation, so the item is an error, not a failure ([Evaluations — Errors are not zeros](/docs/modules/evaluations#errors-are-not-zeros)).

---

## Step 8 — Read the pass rate per kind

The run's `aggregate_scores.grouping` holds one rollup per `kind`, computed like the run's own figures ([Evaluations — Grouped aggregates](/docs/modules/evaluations#grouped-aggregates)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq '.aggregate_scores.grouping | {groups: (.groups | map_values({scored_item_count, pass_rate})), ungrouped_item_count}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: settled } = await adminSoat.evaluations.getEvalRun({
  path: { eval_id: evaluation.id, eval_run_id: baselineRun.id },
});

const grouping = settled.aggregate_scores?.grouping;
for (const [kind, group] of Object.entries(grouping?.groups ?? {})) {
  console.log(kind, group.scored_item_count, group.pass_rate);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.aggregate_scores.grouping | {groups: (.groups | map_values({scored_item_count, pass_rate})), ungrouped_item_count}'
```

</TabItem>
</Tabs>

```json
{
  "groups": {
    "question": { "scored_item_count": 2, "pass_rate": 0.5 },
    "refund": { "scored_item_count": 2, "pass_rate": 0.5 }
  },
  "ungrouped_item_count": 0
}
```

The two kinds fail for different reasons: a question read as a refund fails `json_logic`, an over-limit refund fails `refund-policy`. One overall pass rate cannot say which moved. When kinds need their own thresholds, give each its own dataset and eval.

---

## Step 9 — Fix the agent and measure the fix

Tell the agent the rule, then run against the first run as the baseline ([Evaluations — Baseline deltas](/docs/modules/evaluations#baseline-deltas)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent --agent-id "$AGENT_ID" \
  --instructions "Classify the customer message. category is refund when the customer asks for money back, otherwise question. refund_amount is the amount the customer asks for, never more than the price they say they paid, or 0." \
  --version-label "caps-refund" | jq '{version}'

CANDIDATE_RUN_ID=$(soat start-eval-run --eval-id "$EVAL_ID" --wait false \
  --baseline-run-id "$BASELINE_RUN_ID" | jq -r '.id')

# → retry 300
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$CANDIDATE_RUN_ID" | jq -e '.status == "completed"'

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$CANDIDATE_RUN_ID" \
  | jq '{passed, errored_count, baseline: .aggregate_scores.baseline}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.agents.updateAgent({
  path: { agent_id: agent.id },
  body: {
    instructions:
      'Classify the customer message. category is refund when the customer asks for money back, otherwise question. ' +
      'refund_amount is the amount the customer asks for, never more than the price they say they paid, or 0.',
    version_label: 'caps-refund',
  },
});

const { data: queuedCandidate } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: false, baseline_run_id: baselineRun.id },
});
const candidateRun = await settle(queuedCandidate.id);

console.log(candidateRun.passed, candidateRun.aggregate_scores?.baseline);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"instructions":"Classify the customer message. category is refund when the customer asks for money back, otherwise question. refund_amount is the amount the customer asks for, never more than the price they say they paid, or 0.","version_label":"caps-refund"}' | jq '{version}'

CANDIDATE_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"wait\":false,\"baseline_run_id\":\"$BASELINE_RUN_ID\"}" | jq -r '.id')

until curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$CANDIDATE_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '.status == "completed"' >/dev/null; do
  sleep 2
done
```

</TabItem>
</Tabs>

`baseline.scorers` carries a `refund-policy` entry with its own `pass_rate_delta`, so the rule's movement reads apart from shape and category. `baseline.grouping` carries the same deltas per `kind`, so a fix to refunds that broke questions shows as two groups moving apart. The delta can come back negative: `qwen2.5:0.5b` does not reliably follow the added instruction, and with four items one item is `0.25` of the pass rate. A delta is a fix only once it clears the [noise floor](/docs/advanced/eval-design#noise-before-signal).

---

## What's next

- [Eval Design](/docs/advanced/eval-design) — choosing items, scorers and thresholds.
- [Grade an Eval with a Decider](/docs/tutorials/grade-an-eval-with-a-decider) — grade with the questions production already asks.
- [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) — a rollout that waits for this suite.
- [Evaluations — Custom scorers](/docs/modules/evaluations#custom-scorers-tool) — the full tool scorer contract.
