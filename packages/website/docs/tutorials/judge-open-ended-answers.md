---
description: 'Score answers that have no single correct string: an llm_judge scorer with a required threshold, run queued instead of blocking, polled to a verdict, and cancellable mid-flight.'
keywords:
  - LLM as a judge
  - LLM judge scorer
  - grading AI output
  - queued eval run
  - AI evaluation threshold
  - cancel eval run
sidebar_position: 27
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Judge Open-Ended Answers

`exact_match` and `contains` need a known right string; summaries, explanations and rewrites have many correct forms. An `llm_judge` [scorer](/docs/modules/evaluations#llm-judge) grades the answer with a tool-less model completion through the same [AI providers](/docs/modules/ai-providers) path, returning a 0–1 score plus reasoning.

Bind an `llm_judge` scorer next to a deterministic one, read each item's `score` and `reasoning`, see why an unparseable verdict is an error rather than a zero, run the eval queued and poll, and cancel a run mid-flight. Assumes [Evaluate an Agent](/docs/tutorials/evaluate-an-agent).

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

## Step 2 — An agent with open-ended output

A support-reply drafter: no single correct draft exists. See [Agents](/docs/modules/agents) and [Evaluations — Dataset](/docs/modules/evaluations#dataset).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Judge Workshop" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Reply Drafter" \
  --instructions "Draft a short, warm reply to the customer message. Two sentences at most." | jq -r '.id')

DATASET_ID=$(soat create-dataset --project-id "$PROJECT_ID" --name "reply-drafts" | jq -r '.id')

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"My package arrived damaged. What now?"}]' \
  --expected-output "Apologize, then offer a replacement or a refund and ask for a photo of the damage." | jq -r '.id'

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"I was charged twice this month."}]' \
  --expected-output "Apologize, confirm the duplicate charge will be refunded, and give the expected timeline." | jq -r '.id'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Judge Workshop' },
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
    name: 'Reply Drafter',
    instructions:
      'Draft a short, warm reply to the customer message. Two sentences at most.',
  },
});

const { data: dataset } = await adminSoat.evaluations.createDataset({
  body: { project_id: project.id, name: 'reply-drafts' },
});

await adminSoat.evaluations.createDatasetItem({
  path: { dataset_id: dataset.id },
  body: {
    input: [
      { role: 'user', content: 'My package arrived damaged. What now?' },
    ],
    expected_output:
      'Apologize, then offer a replacement or a refund and ask for a photo of the damage.',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Judge Workshop"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Reply Drafter\",\"instructions\":\"Draft a short, warm reply to the customer message. Two sentences at most.\"}" | jq -r '.id')

DATASET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"reply-drafts\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":[{"role":"user","content":"My package arrived damaged. What now?"}],"expected_output":"Apologize, then offer a replacement or a refund and ask for a photo of the damage."}' | jq -r '.id'
```

</TabItem>
</Tabs>

---

## Step 3 — Bind the judge

The judge's `prompt` has three per-item slots: `{{input}}`, `{{output}}`, `{{expected}}` ([Evaluations — LLM judge](/docs/modules/evaluations#llm-judge)). `pass_threshold` on the scorer is required, no default. Keep a deterministic scorer alongside as a structural floor.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
EVAL_ID=$(soat create-eval \
  --project-id "$PROJECT_ID" \
  --name "reply-quality" \
  --agent-id "$AGENT_ID" \
  --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"json_logic","expression":{"!=":[{"var":"output"},""]}},{"type":"llm_judge","ai_provider_id":"'"$AI_PROVIDER_ID"'","prompt":"You grade customer support drafts. Reply with only JSON: {\"score\": <number 0-1>, \"reasoning\": \"<one sentence>\"}. Customer message: {{input}} Draft reply: {{output}} Reference answer: {{expected}}","pass_threshold":0.7}]' \
  --pass-threshold 0.5 | jq -r '.id')

soat get-eval --eval-id "$EVAL_ID" | jq '.scorers | map({type, pass_threshold})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: evaluation } = await adminSoat.evaluations.createEval({
  body: {
    project_id: project.id,
    name: 'reply-quality',
    agent_id: agent.id,
    dataset_id: dataset.id,
    scorers: [
      { type: 'json_logic', expression: { '!=': [{ var: 'output' }, ''] } },
      {
        type: 'llm_judge',
        ai_provider_id: provider.id,
        prompt:
          'You grade customer support drafts. Reply with only JSON: {"score": <number 0-1>, "reasoning": "<one sentence>"}. ' +
          'Customer message: {{input}} Draft reply: {{output}} Reference answer: {{expected}}',
        pass_threshold: 0.7,
      },
    ],
    pass_threshold: 0.5,
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
EVAL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"reply-quality\",\"agent_id\":\"$AGENT_ID\",\"dataset_id\":\"$DATASET_ID\",\"scorers\":[{\"type\":\"json_logic\",\"expression\":{\"!=\":[{\"var\":\"output\"},\"\"]}},{\"type\":\"llm_judge\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"prompt\":\"You grade customer support drafts. Reply with only JSON: {\\\"score\\\": <number 0-1>, \\\"reasoning\\\": \\\"<one sentence>\\\"}. Customer message: {{input}} Draft reply: {{output}} Reference answer: {{expected}}\",\"pass_threshold\":0.7}],\"pass_threshold\":0.5}" | jq -r '.id')
```

</TabItem>
</Tabs>

Slots fill in one pass: a value containing `{{output}}` is never re-expanded, and an unrecognized `{{…}}` is left as written.

---

## Step 4 — Run it and read the reasoning

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN_ID=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true | jq -r '.id')

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID" \
  | jq '{status, passed, completed_count, errored_count, aggregate_scores}'

soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID" \
  | jq '.data | map({output, error, scores})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: true },
});

const { data: results } = await adminSoat.evaluations.listEvalResults({
  path: { eval_id: evaluation.id, eval_run_id: run.id },
});

for (const result of results.data) {
  const judge = result.scores?.find((s) => s.scorer === 'llm_judge');
  console.log(judge?.score, judge?.reasoning, result.error);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":true}' | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$RUN_ID/results" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({output, error, scores})'
```

</TabItem>
</Tabs>

A judged item (the score gates; `reasoning` is stored for audit):

```json
{
  "output": "I am sorry your package arrived damaged. Send us a photo and we will ship a replacement right away.",
  "error": null,
  "scores": [
    { "scorer": "json_logic", "score": 1, "passed": true },
    {
      "scorer": "llm_judge",
      "score": 0.9,
      "passed": true,
      "reasoning": "Apologizes, asks for a photo, and offers a replacement."
    }
  ]
}
```

:::note[A small judge model may not answer in JSON]

The judge must reply with a JSON object carrying a numeric `score` between 0 and 1. `qwen2.5:0.5b` often ignores that, so items come back with `error` set and no `scores`. An ungraded answer is an error, never a 0; an out-of-range score is rejected, not clamped. Errored items are excluded from `aggregate_scores` and counted in `errored_count`. Use a real judge model ([Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms)) for a suite you gate on.

:::

The judge model is pinned per scorer config; re-run the baseline when you change it. The judge's `ai_provider_id` must belong to the eval's project; the project's default [model route](/docs/modules/model-routes) applies when the scorer pins none.

---

## Step 5 — Run it queued instead of blocking

A judged suite makes two provider calls per item. `wait` selects the mode; both share one execution path, so runs are comparable.

| `wait` | Behavior |
| --- | --- |
| `true` | Executes items sequentially in-process, returns the run **terminal** with its scores. Capped at **25 items**. |
| `false` (default) | Enqueues one task per item, returns immediately with `status: "queued"`. No item cap. |

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
QUEUED_RUN=$(soat start-eval-run --eval-id "$EVAL_ID" --wait false)
QUEUED_RUN_ID=$(printf '%s' "$QUEUED_RUN" | jq -r '.id')

printf '%s' "$QUEUED_RUN" | jq '{status, item_count, aggregate_scores}'

# → retry 180
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$QUEUED_RUN_ID" | jq -e '.status == "completed"'

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$QUEUED_RUN_ID" \
  | jq '{status, passed, completed_count, errored_count, pass_rate: .aggregate_scores.pass_rate}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: queued } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: false },
});
console.log(queued.status); // 'queued'

let settled = queued;
while (settled.status === 'queued' || settled.status === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const { data } = await adminSoat.evaluations.getEvalRun({
    path: { eval_id: evaluation.id, eval_run_id: queued.id },
  });
  settled = data;
}
console.log(settled.passed, settled.aggregate_scores);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
QUEUED_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":false}' | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$QUEUED_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, passed, aggregate_scores}'
```

</TabItem>
</Tabs>

Each item is one queued task; the worker draining the last task settles the run and fires the `eval_run.completed` [webhook](/docs/modules/webhooks) once. Poll the `evrun_…` id or subscribe to the webhook ([Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval)).

An empty dataset is rejected in both modes; a `wait: true` run over 25 items is rejected naming the cap.

---

## Step 6 — Cancel a run mid-flight

Cancelling drops the run's outstanding tasks and settles it `canceled` ([Evaluations — Canceling a run](/docs/modules/evaluations#canceling-a-run)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DOOMED_RUN_ID=$(soat start-eval-run --eval-id "$EVAL_ID" --wait false | jq -r '.id')

soat cancel-eval-run --eval-id "$EVAL_ID" --eval-run-id "$DOOMED_RUN_ID" \
  | jq '{status, item_count, completed_count, errored_count, aggregate_scores, passed}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: doomed } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: false },
});

const { data: canceled } = await adminSoat.evaluations.cancelEvalRun({
  path: { eval_id: evaluation.id, eval_run_id: doomed.id },
});
console.log(canceled.status); // 'canceled'
console.log(canceled.aggregate_scores); // null — deliberately
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DOOMED_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":false}' | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$DOOMED_RUN_ID/cancel" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, aggregate_scores}'
```

</TabItem>
</Tabs>

Expected shape:

```json
{
  "status": "canceled",
  "item_count": 2,
  "completed_count": 0,
  "errored_count": 0,
  "aggregate_scores": null,
  "passed": null
}
```

Written results are kept; `completed_count` / `errored_count` report what ran; `aggregate_scores` stays `null`. A canceled run fires no lifecycle event; cancelling a finished run is a `400`.

---

## Next steps

- [Evaluations — Eval spend](/docs/modules/evaluations#eval-spend-is-separable-from-production-spend) — metered as `source: "eval"` / `"eval_judge"`.
- [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) — a rollout that depends on a green suite.
- [Evaluations — LLM judge](/docs/modules/evaluations#llm-judge) — full contract.
