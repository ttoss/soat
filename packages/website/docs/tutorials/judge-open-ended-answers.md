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

`exact_match` and `contains` work when the right answer is a known string. Most agent output is not like that: a summary, an explanation, a rewritten paragraph — all have many correct forms and no single one to match. Assert on the wording and you measure phrasing, not quality.

An `llm_judge` [scorer](/docs/modules/evaluations#llm-judge) grades the answer with a model completion instead, returning a continuous 0–1 score plus its reasoning. It is an ordinary completion: it resolves through the same [AI providers](/docs/modules/ai-providers) path, traces, and meters like any other call — and it runs **tool-less**, so a judged output can never trigger a side effect.

You will:

1. Create an agent whose output is open-ended by nature.
2. Bind an eval with an `llm_judge` scorer next to a deterministic one.
3. Run it and read each item's `score` **and** the judge's `reasoning`.
4. See what happens when the judge cannot produce a verdict — and why that is an error, not a zero.
5. Run the same eval **queued** instead of blocking, and poll for the verdict.
6. Cancel a run mid-flight and read what survives.

This tutorial assumes you have been through [Evaluate an Agent](/docs/tutorials/evaluate-an-agent), which covers datasets, deterministic scorers, and baseline deltas.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` available. This tutorial uses a local provider so it runs without external credentials — to connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and evaluations first.
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

## Step 2 — An agent with open-ended output

A support-reply drafter. There is no single correct draft, which is exactly why a string matcher cannot grade it. See [Agents](/docs/modules/agents) and [Evaluations — Dataset](/docs/modules/evaluations#dataset) for the resources involved.

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

The judge's `prompt` carries three slots the platform fills per item — see [Evaluations — LLM judge](/docs/modules/evaluations#llm-judge):

| Slot | Filled with |
| --- | --- |
| `{{input}}` | The item's input messages (JSON when not a plain string) |
| `{{output}}` | The agent's final output text |
| `{{expected}}` | The item's `expected_output`, or empty when it has none |

`pass_threshold` on the scorer is **required**, with no default: a judge emits a continuous score, so nothing about the number itself says where "good enough" is, and a defaulted cutoff would silently decide every verdict computed from it. Keep a deterministic scorer alongside the judge — a cheap structural floor that no model opinion can wave through.

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

Slots are filled in **one pass**. A slot value that itself contains `{{output}}` is never re-expanded — a judged output is untrusted text, and re-scanning it would let an agent's own answer rewrite the prompt that grades it. An unrecognized `{{…}}` is left as written rather than blanked, so a typo stays visible instead of silently becoming an empty string.

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

A judged item looks like this — the score gates, and `reasoning` is stored for audit:

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

:::note[A small judge model may not answer in JSON — and that is instructive]

The judge must reply with a JSON object carrying a numeric `score` between 0 and 1. Prose or a code fence around it is tolerated (the first `{…}` span is parsed); the contract itself is not. `qwen2.5:0.5b` is a 0.5B-parameter model and frequently ignores it, so on this local stack you will often see items come back with `error` set and no `scores` at all.

That is the designed behavior, not a bug: a judge that could not reach a verdict means **the answer was never graded**, so recording 0 would fabricate a regression that never happened. An out-of-range score is rejected for the same reason rather than clamped — a judge answering `87` out of 100 is a broken prompt, and clamping it to `1` would report a suspiciously perfect run. Errored items are excluded from `aggregate_scores` and counted in `errored_count`; the generation stays linked either way, because it happened and it cost money. Use a real judge model (see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms)) for a suite you intend to gate on.

:::

Two judging rules matter as soon as you compare runs over time. The judge model is pinned **per scorer config**, because judges drift as models are updated — and deltas between runs judged by *different* models are not comparable, so re-run the baseline when you change the judge. And the judge resolves like any other completion: its `ai_provider_id` must belong to the eval's project, and the project's default [model route](/docs/modules/model-routes) applies when the scorer pins none.

---

## Step 5 — Run it queued instead of blocking

A judged suite makes two provider calls per item, so it is exactly the workload you do not want to hold a request open for. `wait` selects the mode, and both modes share **one** execution and finalize path — so a `wait: true` run and a `wait: false` run of the same eval are directly comparable.

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

# → retry 60
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

Each item becomes one queued task; a worker claims tasks in batches, and the worker that drains the run's **last** task settles it and fires the `eval_run.completed` [webhook](/docs/modules/webhooks). Delivery is at-least-once, which is safe without extra bookkeeping: a result row is unique per `(run, item)`, so a redelivered task re-runs the item into the same row instead of double-counting it. Settling is guarded by an atomic claim, so several workers finishing at the same instant still fire the completion event exactly once — a promotion gate that received the same verdict twice could act twice.

The start response is the handle: `status: "queued"` and the `evrun_…` id to poll. By the time the first `get` lands the run has usually already moved to `running` — the status you poll is the run's live state, not a copy of what the create call said.

Poll as above, or subscribe to the webhook and let the verdict come to you. [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) does the latter.

An **empty** dataset is rejected in both modes: a run that measured nothing must not produce a verdict. And a `wait: true` run over more than 25 items is rejected naming the cap, rather than scored partially — a subset reported in the field a completed run uses would read as a whole-dataset pass/fail. The cap belongs to synchronous execution only; `wait: false` is the answer for a large suite.

---

## Step 6 — Cancel a run mid-flight

A queued run holds real provider budget. Cancelling drops its outstanding tasks, so it stops spending on the next tick, and settles it `canceled` — see [Evaluations — Canceling a run](/docs/modules/evaluations#canceling-a-run).

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

Results already written are **kept** — they are real measurements of generations that were really paid for — and `completed_count` / `errored_count` report what ran. `aggregate_scores` is left `null` on purpose, for the same reason the synchronous cap exists: a partial roll-up in the field a completed run uses would read as a whole-dataset verdict. A canceled run fires no lifecycle event, because it produced no verdict. Cancelling a run that already finished is a `400`.

---

## What you built

| Need | Mechanism |
| --- | --- |
| "Grade an answer with no single right form" | An `llm_judge` scorer with `{{input}}` / `{{output}}` / `{{expected}}` slots |
| "Say where good enough is" | The scorer's required `pass_threshold` |
| "Explain why an item scored what it did" | `reasoning`, stored per result |
| "Don't let one bad grader fabricate a regression" | Unparseable verdicts error the item; errors are never zeros |
| "Don't hold a request open for a long suite" | `wait: false` → poll, or the `eval_run.completed` webhook |
| "Stop a run that is burning budget" | `cancel-eval-run` — measurements kept, aggregates withheld |

A run's spend is separable from production spend: item generations are metered with `source: "eval"` and a judge's own completion with `source: "eval_judge"`, so running a suite can be priced apart from grading it. See [Evaluations — Eval spend](/docs/modules/evaluations#eval-spend-is-separable-from-production-spend) and [Usage](/docs/modules/usage).

Read next: [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) to make a rollout depend on a green suite, and [Evaluations — LLM judge](/docs/modules/evaluations#llm-judge) for the full contract.
