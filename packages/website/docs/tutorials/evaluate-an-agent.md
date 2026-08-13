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

Every time you reword an instruction, swap a model, or add a tool, you ship a change whose effect you cannot see. [Traces](/docs/modules/traces) tell you what one run did. They cannot tell you whether the *distribution* of runs got better or worse — which is the only question that matters when the prompt you just edited serves production traffic.

An [evaluation](/docs/modules/evaluations) answers it. A **dataset** holds test cases, an **eval** binds an agent to that dataset plus a list of **scorers**, and a **run** executes the real agent against every case and scores the outputs.

You will:

1. Create an agent with a deliberately vague prompt.
2. Build a **dataset** of three billing questions, tagged with metadata.
3. Bind an **eval** with two deterministic scorers and a pass threshold.
4. Run it and read the verdict, then the per-item results.
5. Fix the prompt and re-run **against the first run as a baseline** — the delta is the answer to "did that help?".
6. Edit a test case and see that past results kept their **frozen** copy of it.
7. Read what the aggregate numbers do and do not mean.

Everything here is deterministic apart from the model's own wording: the scorers are string and JSON Logic assertions, with no judge model in the evaluation path. For grading open-ended answers, see [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers).

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` available. This tutorial uses a local provider so it runs without external credentials — to connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and generations first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
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
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create the agent under test

A support agent with a vague prompt. The vagueness is the point: it is what the first run will measure and the second will fix. See [Projects](/docs/modules/projects), [AI Providers](/docs/modules/ai-providers), and [Agents](/docs/modules/agents) for the resources it depends on.

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

A **dataset item** is one test case. `input` is an array of `{ role, content }` messages, replayed verbatim as the generation's input — so a case is exactly what a user would have sent. `metadata` is a free-form bag the platform never interprets, readable later from a `json_logic` scorer. See [Evaluations — Dataset item](/docs/modules/evaluations#dataset-item) for the full field list.

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

Datasets are **operator-owned fixtures**. A [content purge](/docs/tutorials/data-retention-and-zero-retention) never deletes or rewrites a dataset item, so an unrelated erasure request cannot quietly stop your suite from being runnable.

---

## Step 4 — Bind an eval with two scorers

An eval freezes the criteria: the agent under test, the dataset, the scorers, and the threshold the run's verdict gates on. Scorer config lives here rather than being read off the agent at run time, so two runs of the same eval are always judged the same way and their comparison measures the **agent** instead of the criteria shifting underneath it.

Two deterministic scorers, each doing a different job:

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

A `json_logic` expression is evaluated over five variables — `input`, `output`, `object` (the structured output, absent unless the agent declares an `output_schema`), `expected`, and `item.metadata`. It runs on the same engine as [orchestration](/docs/modules/orchestrations) mappings, so an assertion means the same thing everywhere in SOAT. See [Evaluations — Scorers](/docs/modules/evaluations#scorers) for the other three types.

---

## Step 5 — Run it and read the verdict

`wait: true` executes the items sequentially in-process and returns the run **terminal**, with its scores. It is capped at 25 items — for anything larger, see [queued runs](/docs/tutorials/judge-open-ended-answers).

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

Expected shape — the `contains` scorer fails every item, because nothing in the prompt asks for a hand-off:

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

Now look at the individual cases. This is where a failing suite becomes actionable — the run-level number says *something* regressed, the results say *which case*.

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

Each result also carries `generation_id`, so any case can be opened as an ordinary [generation](/docs/modules/generations) and its [trace](/docs/tutorials/debug-session-generation-trace-history) read step by step. An eval run is real traffic, not a simulation.

:::warning[Eval runs have real side effects]

Every item is a real generation, so an agent with a write-capable `http` or `mcp` [tool](/docs/modules/tools) performs N real writes per run. There is no tool-stub mode, deliberately — running the real agent is what makes a score mean anything. Point an eval'd agent's tools at a staging target.

:::

---

## Step 6 — Fix the prompt, then measure the fix

Add the missing instruction. This archives a new agent [version](/docs/modules/agents#versioning-and-staged-rollout), which the next run stamps on itself.

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

Expected shape — a positive `pass_rate_delta` is the prompt change paying off:

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

`qwen2.5:0.5b` follows an instruction like this some of the time, not all of it, so your `pass_rate_delta` may be `0.33` or `0.67` rather than `1`. That is the point of measuring instead of guessing — and the reason a suite is judged on its pass **rate**, not on one case. What must hold is the direction: the run that was told about the hand-off scores at least as well as the one that was not.

:::

Positive deltas mean this run scored **higher** than the baseline. Every number is computed over the **item intersection** — the cases present and scorable in both runs — and recomputed from both sides rather than subtracting the two runs' stored aggregates. `added_item_count` and `removed_item_count` report the divergence instead of averaging it in, and a scorer only one of the runs ran is omitted rather than compared against nothing.

---

## Step 7 — Editing a case cannot rewrite history

Dataset items keep full CRUD. That is safe because every result carries its **own frozen copy** of the item's `input` and `expected_output`, taken at run time — see [Evaluations — Frozen inputs](/docs/modules/evaluations#frozen-inputs). Edit a case and the runs that already scored it are untouched.

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

The old result still reads back the wording it was actually scored on. Without that copy, editing a case between two runs would silently make their scores incomparable — and a baseline delta would report **dataset drift as agent regression**, which is the exact failure this module exists to prevent. Deleting an item nulls `dataset_item_id` on past results and changes nothing else.

---

## Step 8 — What the numbers mean

Three levels, each derived from the one below — the full rules live in [Evaluations — Pass semantics](/docs/modules/evaluations#pass-semantics):

| Level | Rule |
| --- | --- |
| Per scorer, per item | A binary scorer passes when its score is 1; an `llm_judge` scorer passes at its own `pass_threshold` |
| Per item | `passed` is the **AND** over that item's per-scorer flags |
| Per run | `passed` is `null` without a `pass_threshold`; otherwise true when the **pass rate** — passed items over non-errored items — is at least the threshold |

The verdict gates on the pass rate, never on a pooled mean: averaging 0/1 binaries together with 0–1 judge fractions produces a unit-less number whose meaning shifts the moment you add a scorer. `aggregate_scores` still reports per-scorer means, so the continuous signal is there — it just does not decide the verdict.

One rule is worth internalizing before you trust a suite:

:::info[Errors are not zeros]

An item whose generation did not complete is recorded as an **error**: excluded from `aggregate_scores`, counted in `errored_count`, never scored 0. The common case is an agent with [client tools](/docs/tutorials/client-tools) pausing for tool outputs — it produced nothing to grade, and scoring that 0 would report a behavioral regression that did not happen. The same holds for a scorer that could not reach a verdict. A run that scored nothing at all does not pass.

:::

---

## What you built

| Need | Mechanism |
| --- | --- |
| "Keep the cases we keep breaking" | A `dataset` of items, each replayed verbatim |
| "Grade without a model in the loop" | `contains` / `json_logic` / `exact_match` / `output_schema` scorers |
| "Did my change help?" | A second run with `baseline_run_id`, compared over the item intersection |
| "Which case broke?" | `list-eval-results` — per item, per scorer, with the `generation_id` |
| "Don't let a fixture edit look like a regression" | Frozen `input` / `expected_output` on every result |
| "Is this release good enough to ship?" | `pass_threshold` → the run's `passed` verdict |

Read next: [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers) for grading answers that have no single right string, [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) to make a rollout wait for a green suite, and [Evaluations](/docs/modules/evaluations) for the full data model.
