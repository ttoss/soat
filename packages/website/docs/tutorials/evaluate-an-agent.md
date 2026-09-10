---
description: 'Turn "did my prompt change make the agent worse?" into a number: build a dataset of test cases, score real runs with deterministic scorers, and compare two runs over the item intersection.'
keywords:
  - AI agent evaluation
  - LLM regression testing
  - prompt regression
  - agent test suite
  - eval dataset
  - baseline comparison
sidebar_position: 26
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Evaluate an Agent

[Traces](/docs/modules/traces) show what one run did; an [evaluation](/docs/modules/evaluations) shows whether the distribution of runs got better or worse after a prompt, model or tool change. A **dataset** holds test cases, an **eval** binds an agent to that dataset plus **scorers**, and a **run** executes the real agent against every case and scores the outputs. Build a small suite, run it, fix the prompt, and measure the fix against the first run as a baseline.

Scorers here are deterministic; no judge model. For open-ended answers, see [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers).

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [Ollama](https://ollama.com) with `qwen2.5:0.5b`. For xAI, OpenAI, Anthropic, or Amazon Bedrock see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- [CLI](/docs/cli) or [SDK](/docs/sdk).

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

## Step 2 — Create the agent under test

A support agent with a deliberately vague prompt; the first run measures it, the second fixes it. See [Projects](/docs/modules/projects), [AI Providers](/docs/modules/ai-providers), and [Agents](/docs/modules/agents).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Eval Workshop" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Billing Assistant" \
  --instructions "You are a billing support assistant. Answer in one short sentence." | jq -r '.id')

echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Eval Workshop' },
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
    name: 'Billing Assistant',
    instructions:
      'You are a billing support assistant. Answer in one short sentence.',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Eval Workshop"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Billing Assistant\",\"instructions\":\"You are a billing support assistant. Answer in one short sentence.\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Build a dataset

A **dataset item** is one test case: `input` is an array of `{ role, content }` messages replayed verbatim as the generation's input; `metadata` is a free-form bag the platform never interprets, readable from a `json_logic` scorer. Fields: [Evaluations — Dataset item](/docs/modules/evaluations#dataset-item).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DATASET_ID=$(soat create-dataset \
  --project-id "$PROJECT_ID" \
  --name "billing-questions" \
  --description "Questions every release must still answer" | jq -r '.id')

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"When is my invoice issued?"}]' \
  --expected-output "Your invoice is issued on the first of each month." \
  --metadata '{"topic":"invoicing"}' | jq -r '.id'

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"How do I get a refund?"}]' \
  --expected-output "Open a refund request from the order page." \
  --metadata '{"topic":"refunds"}' | jq -r '.id'

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"How do I cancel my plan?"}]' \
  --expected-output "Cancel from Billing then Subscription." \
  --metadata '{"topic":"cancellation"}' | jq -r '.id'

soat list-dataset-items --dataset-id "$DATASET_ID" | jq '.data | map({id, topic: .metadata.topic})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: dataset } = await adminSoat.evaluations.createDataset({
  body: {
    project_id: project.id,
    name: 'billing-questions',
    description: 'Questions every release must still answer',
  },
});

const cases = [
  {
    question: 'When is my invoice issued?',
    expected: 'Your invoice is issued on the first of each month.',
    topic: 'invoicing',
  },
  {
    question: 'How do I get a refund?',
    expected: 'Open a refund request from the order page.',
    topic: 'refunds',
  },
  {
    question: 'How do I cancel my plan?',
    expected: 'Cancel from Billing then Subscription.',
    topic: 'cancellation',
  },
];

for (const testCase of cases) {
  await adminSoat.evaluations.createDatasetItem({
    path: { dataset_id: dataset.id },
    body: {
      input: [{ role: 'user', content: testCase.question }],
      expected_output: testCase.expected,
      metadata: { topic: testCase.topic },
    },
  });
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DATASET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"billing-questions\",\"description\":\"Questions every release must still answer\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":[{"role":"user","content":"When is my invoice issued?"}],"expected_output":"Your invoice is issued on the first of each month.","metadata":{"topic":"invoicing"}}' | jq -r '.id'

curl -s "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({id, topic: .metadata.topic})'
```

</TabItem>
</Tabs>

A [content purge](/docs/tutorials/data-retention-and-zero-retention) never deletes or rewrites a dataset item.

---

## Step 4 — Bind an eval with two scorers

An eval freezes the criteria: agent under test, dataset, scorers, and the threshold the verdict gates on. Scorer config lives on the eval, not the agent, so two runs are judged the same way and their comparison measures the agent.

Two deterministic scorers:

| Scorer | Asks |
| --- | --- |
| `json_logic` | Did the agent answer at all? |
| `contains` | Did it include the mandated support hand-off? |

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
EVAL_ID=$(soat create-eval \
  --project-id "$PROJECT_ID" \
  --name "billing-regression" \
  --agent-id "$AGENT_ID" \
  --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"json_logic","expression":{"!=":[{"var":"output"},""]}},{"type":"contains","value":"billing@example.com"}]' \
  --pass-threshold 0.67 | jq -r '.id')

soat get-eval --eval-id "$EVAL_ID" | jq '{name, pass_threshold, scorers}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: evaluation } = await adminSoat.evaluations.createEval({
  body: {
    project_id: project.id,
    name: 'billing-regression',
    agent_id: agent.id,
    dataset_id: dataset.id,
    scorers: [
      { type: 'json_logic', expression: { '!=': [{ var: 'output' }, ''] } },
      { type: 'contains', value: 'billing@example.com' },
    ],
    pass_threshold: 0.67,
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
EVAL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"billing-regression\",\"agent_id\":\"$AGENT_ID\",\"dataset_id\":\"$DATASET_ID\",\"scorers\":[{\"type\":\"json_logic\",\"expression\":{\"!=\":[{\"var\":\"output\"},\"\"]}},{\"type\":\"contains\",\"value\":\"billing@example.com\"}],\"pass_threshold\":0.67}" | jq -r '.id')
```

</TabItem>
</Tabs>

A `json_logic` expression is evaluated over `input`, `output`, `object`, `expected`, and `item.metadata`; other scorer types: [Evaluations — Scorers](/docs/modules/evaluations#scorers).

---

## Step 5 — Run it and read the verdict

`wait: true` executes the items sequentially in-process and returns the run terminal, with scores. Capped at 25 items; larger suites use [queued runs](/docs/tutorials/judge-open-ended-answers).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
BASELINE_RUN_ID=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true | jq -r '.id')

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq '{status, passed, agent_version, item_count, completed_count, errored_count, aggregate_scores}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: baselineRun } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: true },
});

console.log(baselineRun.status); // 'completed'
console.log(baselineRun.passed); // false — the prompt never mentions the hand-off
console.log(baselineRun.aggregate_scores);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
BASELINE_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":true}' | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, passed, aggregate_scores}'
```

</TabItem>
</Tabs>

Expected shape (`contains` fails every item; the prompt never asks for a hand-off):

```json
{
  "status": "completed",
  "passed": false,
  "agent_version": 1,
  "item_count": 3,
  "completed_count": 3,
  "errored_count": 0,
  "aggregate_scores": {
    "scorers": {
      "json_logic": { "mean": 1, "pass_rate": 1 },
      "contains": { "mean": 0, "pass_rate": 0 }
    },
    "pass_rate": 0,
    "scored_item_count": 3
  }
}
```

Per-item results say which case regressed:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq '.data | map({input: .input[0].content, output, passed, scores: [.scores[] | {scorer, score}]})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: results } = await adminSoat.evaluations.listEvalResults({
  path: { eval_id: evaluation.id, eval_run_id: baselineRun.id },
});

for (const result of results.data) {
  console.log(result.passed, result.output, result.scores);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID/results" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data | map({output, passed, scores})'
```

</TabItem>
</Tabs>

Each result carries `generation_id`, so any case opens as an ordinary [generation](/docs/modules/generations) with a readable [trace](/docs/tutorials/debug-session-generation-trace-history).

:::warning[Eval runs have real side effects]

Every item is a real generation: an agent with a write-capable `http` or `mcp` [tool](/docs/modules/tools) performs N real writes per run. There is no tool-stub mode. Point an eval'd agent's tools at a staging target.

:::

---

## Step 6 — Fix the prompt, then measure the fix

Add the missing instruction; this archives a new agent [version](/docs/modules/agents#versioning-and-staged-rollout), stamped on the next run.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent --agent-id "$AGENT_ID" \
  --instructions "You are a billing support assistant. Answer in one short sentence, then add: For more help, contact billing@example.com" \
  --version-label "adds-handoff" | jq '{version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: v2 } = await adminSoat.agents.updateAgent({
  path: { agent_id: agent.id },
  body: {
    instructions:
      'You are a billing support assistant. Answer in one short sentence, then add: For more help, contact billing@example.com',
    version_label: 'adds-handoff',
  },
});
console.log(v2.version); // 2
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"instructions":"You are a billing support assistant. Answer in one short sentence, then add: For more help, contact billing@example.com","version_label":"adds-handoff"}' \
  | jq '{version}'
```

</TabItem>
</Tabs>

Re-run the **same** eval, naming the first run as the baseline:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CANDIDATE_RUN_ID=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true \
  --baseline-run-id "$BASELINE_RUN_ID" | jq -r '.id')

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$CANDIDATE_RUN_ID" \
  | jq '{passed, agent_version, pass_rate: .aggregate_scores.pass_rate, baseline: .aggregate_scores.baseline}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: candidateRun } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: true, baseline_run_id: baselineRun.id },
});

console.log(candidateRun.agent_version); // 2
console.log(candidateRun.aggregate_scores?.baseline);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CANDIDATE_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"wait\":true,\"baseline_run_id\":\"$BASELINE_RUN_ID\"}" | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$CANDIDATE_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.aggregate_scores.baseline'
```

</TabItem>
</Tabs>

Expected shape (positive `pass_rate_delta` = improvement over the baseline):

```json
{
  "passed": true,
  "agent_version": 2,
  "pass_rate": 1,
  "baseline": {
    "run_id": "evrun_stmdkHIXmu4KwTDl",
    "scorers": {
      "json_logic": { "mean_delta": 0, "pass_rate_delta": 0 },
      "contains": { "mean_delta": 1, "pass_rate_delta": 1 }
    },
    "pass_rate_delta": 1,
    "compared_item_count": 3,
    "added_item_count": 0,
    "removed_item_count": 0
  }
}
```

:::note[Your numbers will differ]

`qwen2.5:0.5b` follows the instruction only some of the time, so `pass_rate_delta` may be `0.33` or `0.67` rather than `1`. The direction must hold: the run told about the hand-off scores at least as well as the one that was not.

:::

Every delta is computed over the item intersection (cases present and scorable in both runs); comparison rules: [Evaluations](/docs/modules/evaluations).

---

## Step 7 — Editing a case cannot rewrite history

Every result carries its own frozen copy of the item's `input` and `expected_output`, taken at run time ([Evaluations — Frozen inputs](/docs/modules/evaluations#frozen-inputs)), so dataset items keep full CRUD without touching past runs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ITEM_ID=$(soat list-dataset-items --dataset-id "$DATASET_ID" | jq -r '.data[0].id')

soat update-dataset-item --dataset-id "$DATASET_ID" --item-id "$ITEM_ID" \
  --input '[{"role":"user","content":"On what day is my invoice issued?"}]' \
  --expected-output "On the first of each month." | jq '{id, input}'

soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq '.data[0] | {frozen_input: .input[0].content, frozen_expected: .expected_output}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: items } = await adminSoat.evaluations.listDatasetItems({
  path: { dataset_id: dataset.id },
});
const first = items.data[0];

await adminSoat.evaluations.updateDatasetItem({
  path: { dataset_id: dataset.id, item_id: first.id },
  body: {
    input: [{ role: 'user', content: 'On what day is my invoice issued?' }],
    expected_output: 'On the first of each month.',
  },
});

const { data: old } = await adminSoat.evaluations.listEvalResults({
  path: { eval_id: evaluation.id, eval_run_id: baselineRun.id },
});
console.log(old.data[0].input); // still the original wording
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ITEM_ID=$(curl -s "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data[0].id')

curl -s -X PUT "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items/$ITEM_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":[{"role":"user","content":"On what day is my invoice issued?"}],"expected_output":"On the first of each month."}' | jq '{id, input}'

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID/results" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0] | {input, expected_output}'
```

</TabItem>
</Tabs>

A baseline delta therefore never reports dataset drift as agent regression. Deleting an item nulls `dataset_item_id` on past results and changes nothing else.

---

## Step 8 — What the numbers mean

[Evaluations — Pass semantics](/docs/modules/evaluations#pass-semantics): an item passes when all its scorers pass; the run's verdict gates on the pass rate against `pass_threshold`, never on a pooled mean.

:::info[Errors are not zeros]

An item whose generation did not complete is an **error**: excluded from `aggregate_scores`, counted in `errored_count`, never scored 0. A run that scored nothing does not pass.

:::

---

## What's next

- [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers) — answers with no single right string.
- [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) — a rollout that waits for a green suite.
- [Evaluations](/docs/modules/evaluations) — full data model.
