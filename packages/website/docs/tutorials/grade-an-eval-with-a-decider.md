---
description: "One versioned judgment in two layers: a decider reviews a live support reply, then grades every item of an eval as a decider scorer."
keywords:
  - deciders
  - decider scorer
  - evaluations
  - calibrated judgments
  - TypeSafe Jev
  - pipeline tools
sidebar_position: 33
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Grade an Eval with a Decider

A support agent drafts replies; a [decider](/docs/modules/deciders) named `reply-review` asks three questions about each one: does it resolve the issue, does it respect policy, how warm is it. The same decider reviews a live reply before it is sent and grades every item of an [eval](/docs/modules/evaluations) as a [`decider` scorer](/docs/modules/evaluations#decider-scorers-decider), so the eval measures exactly what production enforces.

The decider is answered by [TypeSafe Jev](https://docs.typesafe.ai/introduction.md), a model that returns calibrated probabilities instead of text, through a [pipeline tool](/docs/modules/tools#pipeline) that bridges its answer shape to the decider contract.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts).
- [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) for datasets, evals and runs.
- [Route Work with a Decider](/docs/tutorials/route-work-with-a-decider) for deciders and tool backends.
- A [TypeSafe API key](https://console.typesafe.ai/keys). Not needed against the mock endpoint the tutorial tests run with.
- `api.typesafe.ai` in [`TOOL_EGRESS_ALLOWED_HOSTS`](/docs/self-hosting/configuration) when your server restricts tool egress.
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1

# The default is the real endpoint; overridable so the tutorial also runs against a mock.
export TYPESAFE_BASE_URL="${TYPESAFE_BASE_URL:-https://api.typesafe.ai}"
export TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-apikey_your-typesafe-key}"
```

---

## Step 1 — Log in as admin

See [Users](/docs/modules/users#examples) for authentication.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login!.token,
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

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "support-desk" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'support-desk' },
});
const PROJECT_ID = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"support-desk"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Reach Jev from a tool

The key goes in a [secret](/docs/modules/secrets), and the `http` tool names it by reference, so no read of the tool returns it. `model` is pinned in `preset_parameters`: every call asks `jev-latest`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SECRET_ID=$(soat create-secret --project-id "$PROJECT_ID" \
  --name typesafe-api-key --value "$TYPESAFE_API_KEY" | jq -r '.id')

JEV_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name jev-systemone \
  --type http \
  --description "TypeSafe Jev evaluation endpoint" \
  --parameters '{"type":"object","properties":{"state":{},"questions":{"type":"object"}},"required":["state","questions"]}' \
  --execute '{
    "url": "'"$TYPESAFE_BASE_URL"'/v1/systemone",
    "method": "POST",
    "headers": {"Authorization": "Bearer {{secret:'"$SECRET_ID"'}}"}
  }' \
  --preset-parameters '{"model": "jev-latest"}' | jq -r '.id')
echo "Jev tool: $JEV_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: secret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'typesafe-api-key',
    value: process.env.TYPESAFE_API_KEY!,
  },
});

const { data: jevTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'jev-systemone',
    type: 'http',
    description: 'TypeSafe Jev evaluation endpoint',
    parameters: {
      type: 'object',
      properties: { state: {}, questions: { type: 'object' } },
      required: ['state', 'questions'],
    },
    execute: {
      url: `${process.env.TYPESAFE_BASE_URL}/v1/systemone`,
      method: 'POST',
      headers: { Authorization: `Bearer {{secret:${secret!.id}}}` },
    },
    preset_parameters: { model: 'jev-latest' },
  },
});
const JEV_TOOL_ID = jevTool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"typesafe-api-key","value":"'"$TYPESAFE_API_KEY"'"}' \
  | jq -r '.id')

JEV_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "jev-systemone",
    "type": "http",
    "description": "TypeSafe Jev evaluation endpoint",
    "parameters": {"type":"object","properties":{"state":{},"questions":{"type":"object"}},"required":["state","questions"]},
    "execute": {
      "url": "'"$TYPESAFE_BASE_URL"'/v1/systemone",
      "method": "POST",
      "headers": {"Authorization": "Bearer {{secret:'"$SECRET_ID"'}}"}
    },
    "preset_parameters": {"model": "jev-latest"}
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Bridge Jev's answers to the decider contract

A decider calls its tool with `{ input, questions }` and reads back `{ answers: [...] }`. Jev speaks a neighbouring shape, and a [pipeline tool](/docs/modules/tools#pipeline) translates both ways ([Bridging an engine with a pipeline](/docs/modules/deciders#bridging-an-engine-with-a-pipeline)):

| Jev | Decider contract | Bridge |
| --- | --- | --- |
| `{ state, questions }`, questions keyed by id | `{ input, questions }`, questions an array | `state` = `input`; each question read by position |
| `noul` question, answered as `noul`, a probability | `predicate`, answered as `probability` | `type: "noul"` in; `probability` = `noul` out |
| `criteria`, a list of level labels | `levels`, a list of `{ label, description }` | `criteria` = each level's `label` |
| `score` is the probability-weighted level (`1.9`) | `score` is a level index (`2`) | rounded: `(s + 0.5) - ((s + 0.5) % 1)` |
| `probabilities` keyed by level index | `probabilities`, a list of `{ value, probability }` | one entry per level |
| `legend` and `confidence` beside every answer | not read | the output names each field, which leaves them behind |

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
BRIDGE_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name jev-reply-review \
  --type pipeline \
  --description "Answers reply-review through Jev" \
  --pipeline '{
    "steps": [{
      "id": "jev",
      "tool_id": "'"$JEV_TOOL_ID"'",
      "input": {
        "state": {"var": "input.input"},
        "questions": {
          "resolves_issue": {"type": "noul", "instructions": {"var": "input.questions.0.instructions"}},
          "respects_policy": {"type": "noul", "instructions": {"var": "input.questions.1.instructions"}},
          "tone": {
            "type": "score",
            "instructions": {"var": "input.questions.2.instructions"},
            "criteria": {"map": [{"var": "input.questions.2.levels"}, {"var": "label"}]}
          }
        }
      }
    }],
    "output": {
      "answers": [
        {"name": "resolves_issue", "probability": {"var": "steps.jev.answers.resolves_issue.noul"}},
        {"name": "respects_policy", "probability": {"var": "steps.jev.answers.respects_policy.noul"}},
        {
          "name": "tone",
          "score": {"-": [
            {"+": [{"var": "steps.jev.answers.tone.score"}, 0.5]},
            {"%": [{"+": [{"var": "steps.jev.answers.tone.score"}, 0.5]}, 1]}
          ]},
          "probabilities": [
            {"value": 0, "probability": {"var": "steps.jev.answers.tone.probabilities.0"}},
            {"value": 1, "probability": {"var": "steps.jev.answers.tone.probabilities.1"}},
            {"value": 2, "probability": {"var": "steps.jev.answers.tone.probabilities.2"}}
          ]
        }
      ]
    }
  }' | jq -r '.id')
echo "Bridge: $BRIDGE_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const noul = (position: number) => {
  return {
    type: 'noul',
    instructions: { var: `input.questions.${position}.instructions` },
  };
};
const predicate = (name: string) => {
  return { name, probability: { var: `steps.jev.answers.${name}.noul` } };
};
const toneScore = { var: 'steps.jev.answers.tone.score' };

const { data: bridge } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'jev-reply-review',
    type: 'pipeline',
    description: 'Answers reply-review through Jev',
    pipeline: {
      steps: [
        {
          id: 'jev',
          tool_id: JEV_TOOL_ID,
          input: {
            state: { var: 'input.input' },
            questions: {
              resolves_issue: noul(0),
              respects_policy: noul(1),
              tone: {
                type: 'score',
                instructions: { var: 'input.questions.2.instructions' },
                criteria: {
                  map: [{ var: 'input.questions.2.levels' }, { var: 'label' }],
                },
              },
            },
          },
        },
      ],
      output: {
        answers: [
          predicate('resolves_issue'),
          predicate('respects_policy'),
          {
            name: 'tone',
            score: {
              '-': [
                { '+': [toneScore, 0.5] },
                { '%': [{ '+': [toneScore, 0.5] }, 1] },
              ],
            },
            probabilities: [0, 1, 2].map((value) => {
              return {
                value,
                probability: { var: `steps.jev.answers.tone.probabilities.${value}` },
              };
            }),
          },
        ],
      },
    },
  },
});
const BRIDGE_ID = bridge!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
BRIDGE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "jev-reply-review",
    "type": "pipeline",
    "description": "Answers reply-review through Jev",
    "pipeline": {
      "steps": [{
        "id": "jev",
        "tool_id": "'"$JEV_TOOL_ID"'",
        "input": {
          "state": {"var": "input.input"},
          "questions": {
            "resolves_issue": {"type": "noul", "instructions": {"var": "input.questions.0.instructions"}},
            "respects_policy": {"type": "noul", "instructions": {"var": "input.questions.1.instructions"}},
            "tone": {
              "type": "score",
              "instructions": {"var": "input.questions.2.instructions"},
              "criteria": {"map": [{"var": "input.questions.2.levels"}, {"var": "label"}]}
            }
          }
        }
      }],
      "output": {
        "answers": [
          {"name": "resolves_issue", "probability": {"var": "steps.jev.answers.resolves_issue.noul"}},
          {"name": "respects_policy", "probability": {"var": "steps.jev.answers.respects_policy.noul"}},
          {
            "name": "tone",
            "score": {"-": [
              {"+": [{"var": "steps.jev.answers.tone.score"}, 0.5]},
              {"%": [{"+": [{"var": "steps.jev.answers.tone.score"}, 0.5]}, 1]}
            ]},
            "probabilities": [
              {"value": 0, "probability": {"var": "steps.jev.answers.tone.probabilities.0"}},
              {"value": 1, "probability": {"var": "steps.jev.answers.tone.probabilities.1"}},
              {"value": 2, "probability": {"var": "steps.jev.answers.tone.probabilities.2"}}
            ]
          }
        ]
      }
    }
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

The bridge is written for one question set: it reads each question by its position and answers each by name, and `tone` has three levels. A question added, moved or given another level count fails its decisions until the bridge follows.

---

## Step 5 — Create the decider

The questions are an array, in the order the bridge reads them. Jev accepts at most 10 levels on a `score`, fewer than a decider allows, so keep scores to 10 levels or less.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DECIDER_ID=$(soat create-decider \
  --project-id "$PROJECT_ID" \
  --name reply-review \
  --tool-id "$BRIDGE_ID" \
  --questions '[
    {
      "type": "predicate",
      "name": "resolves_issue",
      "instructions": "Does the `reply` resolve what the `customer` asked?"
    },
    {
      "type": "predicate",
      "name": "respects_policy",
      "instructions": "Does the `reply` avoid promising refunds, credits or dates the agent cannot grant?"
    },
    {
      "type": "score",
      "name": "tone",
      "instructions": "How warm is the `reply`?",
      "levels": [
        {"label": "Cold", "description": "Curt or dismissive."},
        {"label": "Neutral", "description": "Polite but impersonal."},
        {"label": "Warm", "description": "Friendly and empathetic."}
      ]
    }
  ]' | jq -r '.id')
echo "Decider: $DECIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const QUESTIONS = [
  {
    type: 'predicate',
    name: 'resolves_issue',
    instructions: 'Does the `reply` resolve what the `customer` asked?',
  },
  {
    type: 'predicate',
    name: 'respects_policy',
    instructions:
      'Does the `reply` avoid promising refunds, credits or dates the agent cannot grant?',
  },
  {
    type: 'score',
    name: 'tone',
    instructions: 'How warm is the `reply`?',
    levels: [
      { label: 'Cold', description: 'Curt or dismissive.' },
      { label: 'Neutral', description: 'Polite but impersonal.' },
      { label: 'Warm', description: 'Friendly and empathetic.' },
    ],
  },
];

const { data: decider } = await adminSoat.deciders.createDecider({
  body: {
    project_id: PROJECT_ID,
    name: 'reply-review',
    tool_id: BRIDGE_ID,
    questions: QUESTIONS,
  },
});
const DECIDER_ID = decider!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DECIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/deciders" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "reply-review",
    "tool_id": "'"$BRIDGE_ID"'",
    "questions": [
      {"type": "predicate", "name": "resolves_issue", "instructions": "Does the `reply` resolve what the `customer` asked?"},
      {"type": "predicate", "name": "respects_policy", "instructions": "Does the `reply` avoid promising refunds, credits or dates the agent cannot grant?"},
      {"type": "score", "name": "tone", "instructions": "How warm is the `reply`?", "levels": [
        {"label": "Cold", "description": "Curt or dismissive."},
        {"label": "Neutral", "description": "Polite but impersonal."},
        {"label": "Warm", "description": "Friendly and empathetic."}
      ]}
    ]
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 6 — Review a live reply

In production the decider sits in the loop: before a reply is sent, ask it with [`POST /api/v1/deciders/{decider_id}/decisions`](/docs/api/deciders/create-decision). The input names `customer` and `reply`, the fields the instructions point at in backticks.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-decision \
  --decider-id "$DECIDER_ID" \
  --input '{
    "customer": "I was charged twice for order 1042.",
    "reply": "Sorry about that! I have flagged the duplicate charge for our billing team, who will reverse it."
  }' \
  --metadata '{"ticket_id": "ZD-1042"}' \
  --wait true | jq '{status, decider_version, answers}'
```

Expected output against the mock (Jev's own figures vary):

```json
{
  "status": "completed",
  "decider_version": 1,
  "answers": [
    { "type": "predicate", "name": "resolves_issue", "probability": 0.85 },
    { "type": "predicate", "name": "respects_policy", "probability": 0.85 },
    {
      "type": "score",
      "name": "tone",
      "score": 2,
      "probabilities": [
        { "value": 0, "label": "Cold", "probability": 0 },
        { "value": 1, "label": "Neutral", "probability": 0.1 },
        { "value": 2, "label": "Warm", "probability": 0.9 }
      ]
    }
  ]
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: live } = await adminSoat.deciders.createDecision({
  path: { decider_id: DECIDER_ID },
  body: {
    input: {
      customer: 'I was charged twice for order 1042.',
      reply:
        'Sorry about that! I have flagged the duplicate charge for our billing team, who will reverse it.',
    },
    metadata: { ticket_id: 'ZD-1042' },
    wait: true,
  },
});
console.log(live!.answers);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/deciders/$DECIDER_ID/decisions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "customer": "I was charged twice for order 1042.",
      "reply": "Sorry about that! I have flagged the duplicate charge for our billing team, who will reverse it."
    },
    "metadata": {"ticket_id": "ZD-1042"},
    "wait": true
  }' | jq '{status, decider_version, answers}'
```

</TabItem>
</Tabs>

`tone.probabilities` is Jev's distribution over the levels, labelled from the decider's own levels: the certainty a bare `score: 2` drops. The same answers are keyed by name in `answers_by_name`.

---

## Step 7 — The agent under test and its dataset

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Replier" \
  --instructions "Reply to the customer in two sentences. Never promise a refund; say billing will review it." \
  | jq -r '.id')

DATASET_ID=$(soat create-dataset --project-id "$PROJECT_ID" --name support-replies | jq -r '.id')

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role": "user", "content": "I was charged twice for order 1042."}]' > /dev/null
soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role": "user", "content": "My invoice shows the wrong company name."}]' > /dev/null
echo "Agent: $AGENT_ID  Dataset: $DATASET_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: provider!.id,
    name: 'Support Replier',
    instructions:
      'Reply to the customer in two sentences. Never promise a refund; say billing will review it.',
  },
});
const AGENT_ID = agent!.id;

const { data: dataset } = await adminSoat.evaluations.createDataset({
  body: { project_id: PROJECT_ID, name: 'support-replies' },
});
const DATASET_ID = dataset!.id;

for (const content of [
  'I was charged twice for order 1042.',
  'My invoice shows the wrong company name.',
]) {
  await adminSoat.evaluations.createDatasetItem({
    path: { dataset_id: DATASET_ID },
    body: { input: [{ role: 'user', content }] },
  });
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Local Ollama","provider":"ollama","default_model":"qwen2.5:0.5b"}' \
  | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","ai_provider_id":"'"$AI_PROVIDER_ID"'","name":"Support Replier","instructions":"Reply to the customer in two sentences. Never promise a refund; say billing will review it."}' \
  | jq -r '.id')

DATASET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"support-replies"}' | jq -r '.id')

for CONTENT in "I was charged twice for order 1042." "My invoice shows the wrong company name."; do
  curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"input":[{"role":"user","content":"'"$CONTENT"'"}]}' > /dev/null
done
```

</TabItem>
</Tabs>

---

## Step 8 — Bind the decider as a scorer and run

`input` maps each item into the shape the questions read; `score` reads the decision's answers by name. Averaging the two `probability` values keeps Jev's certainty in the score: a reply Jev is unsure about scores lower than one it is sure about, even when both predicates hold.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
EVAL_ID=$(soat create-eval \
  --project-id "$PROJECT_ID" \
  --name reply-quality \
  --agent-id "$AGENT_ID" \
  --dataset-id "$DATASET_ID" \
  --scorers '[{
    "type": "decider",
    "name": "reply_review",
    "decider_id": "'"$DECIDER_ID"'",
    "input": {"customer": {"var": "input.0.content"}, "reply": {"var": "output"}},
    "score": {"/": [{"+": [
      {"var": "answers_by_name.resolves_issue.probability"},
      {"var": "answers_by_name.respects_policy.probability"}
    ]}, 2]},
    "pass_threshold": 0.7
  }]' \
  --pass-threshold 0.8 | jq -r '.id')

BASELINE_RUN=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true)
BASELINE_RUN_ID=$(echo "$BASELINE_RUN" | jq -r '.id')
echo "$BASELINE_RUN" | jq '{status, passed, decider_versions, reply_review: .aggregate_scores.scorers.reply_review}'
```

Expected output against the mock:

```json
{
  "status": "completed",
  "passed": true,
  "decider_versions": { "reply_review": 1 },
  "reply_review": { "mean": 0.85, "pass_rate": 1 }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: evaluation } = await adminSoat.evaluations.createEval({
  body: {
    project_id: PROJECT_ID,
    name: 'reply-quality',
    agent_id: AGENT_ID,
    dataset_id: DATASET_ID,
    scorers: [
      {
        type: 'decider',
        name: 'reply_review',
        decider_id: DECIDER_ID,
        input: { customer: { var: 'input.0.content' }, reply: { var: 'output' } },
        score: {
          '/': [
            {
              '+': [
                { var: 'answers_by_name.resolves_issue.probability' },
                { var: 'answers_by_name.respects_policy.probability' },
              ],
            },
            2,
          ],
        },
        pass_threshold: 0.7,
      },
    ],
    pass_threshold: 0.8,
  },
});
const EVAL_ID = evaluation!.id;

const { data: baseline } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: EVAL_ID },
  body: { wait: true },
});
console.log(baseline!.decider_versions, baseline!.aggregate_scores);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
EVAL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "reply-quality",
    "agent_id": "'"$AGENT_ID"'",
    "dataset_id": "'"$DATASET_ID"'",
    "scorers": [{
      "type": "decider",
      "name": "reply_review",
      "decider_id": "'"$DECIDER_ID"'",
      "input": {"customer": {"var": "input.0.content"}, "reply": {"var": "output"}},
      "score": {"/": [{"+": [
        {"var": "answers_by_name.resolves_issue.probability"},
        {"var": "answers_by_name.respects_policy.probability"}
      ]}, 2]},
      "pass_threshold": 0.7
    }],
    "pass_threshold": 0.8
  }' | jq -r '.id')

BASELINE_RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wait": true}' | jq -r '.id')
```

</TabItem>
</Tabs>

A failed decision, or a `score` outside 0–1, errors the item instead of scoring it 0 ([errors are not zeros](/docs/modules/evaluations#errors-are-not-zeros)).

---

## Step 9 — Read the decision behind an item

Each score carries the `decision_id` that produced it; the decision's `metadata` points back at the eval, the run and the item.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ITEM_DECISION_ID=$(soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$BASELINE_RUN_ID" \
  | jq -r '.data[0].scores[0].decision_id')

soat get-decision --decision-id "$ITEM_DECISION_ID" \
  | jq '{decider_version, tone: .answers_by_name.tone.score, run: .metadata.eval_run_id}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: results } = await adminSoat.evaluations.listEvalResults({
  path: { eval_id: EVAL_ID, eval_run_id: baseline!.id },
});
const decisionId = results!.data![0].scores![0].decision_id!;

const { data: itemDecision } = await adminSoat.deciders.getDecision({
  path: { decision_id: decisionId },
});
console.log(
  itemDecision!.decider_version,
  itemDecision!.answers_by_name!.tone,
  itemDecision!.metadata
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ITEM_DECISION_ID=$(curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$BASELINE_RUN_ID/results" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data[0].scores[0].decision_id')

curl -s "$SOAT_BASE_URL/api/v1/decisions/$ITEM_DECISION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{decider_version, tone: .answers_by_name.tone.score, run: .metadata.eval_run_id}'
```

</TabItem>
</Tabs>

---

## Step 10 — Change the criteria, see the pin

Rewording a question archives a new decider version. A run grades every item under the version it started with and names it in `decider_versions`, so comparing against the baseline says which criteria each run used.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-decider --decider-id "$DECIDER_ID" --questions '[
  {"type": "predicate", "name": "resolves_issue", "instructions": "Does the `reply` resolve what the `customer` asked, or name who will?"},
  {"type": "predicate", "name": "respects_policy", "instructions": "Does the `reply` avoid promising refunds, credits or dates the agent cannot grant?"},
  {"type": "score", "name": "tone", "instructions": "How warm is the `reply`?", "levels": [
    {"label": "Cold", "description": "Curt or dismissive."},
    {"label": "Neutral", "description": "Polite but impersonal."},
    {"label": "Warm", "description": "Friendly and empathetic."}
  ]}
]' | jq '{version}'

soat start-eval-run --eval-id "$EVAL_ID" --baseline-run-id "$BASELINE_RUN_ID" --wait true \
  | jq '{decider_versions, reply_review: .aggregate_scores.scorers.reply_review}'
```

Expected output against the mock:

```json
{ "version": 2 }
{
  "decider_versions": { "reply_review": 2 },
  "reply_review": { "mean": 0.85, "pass_rate": 1 }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.deciders.updateDecider({
  path: { decider_id: DECIDER_ID },
  body: {
    questions: [
      {
        ...QUESTIONS[0],
        instructions:
          'Does the `reply` resolve what the `customer` asked, or name who will?',
      },
      QUESTIONS[1],
      QUESTIONS[2],
    ],
  },
});

const { data: candidate } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: EVAL_ID },
  body: { baseline_run_id: baseline!.id, wait: true },
});
console.log(candidate!.decider_versions); // { reply_review: 2 }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/deciders/$DECIDER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"questions": [
    {"type": "predicate", "name": "resolves_issue", "instructions": "Does the `reply` resolve what the `customer` asked, or name who will?"},
    {"type": "predicate", "name": "respects_policy", "instructions": "Does the `reply` avoid promising refunds, credits or dates the agent cannot grant?"},
    {"type": "score", "name": "tone", "instructions": "How warm is the `reply`?", "levels": [
      {"label": "Cold", "description": "Curt or dismissive."},
      {"label": "Neutral", "description": "Polite but impersonal."},
      {"label": "Warm", "description": "Friendly and empathetic."}
    ]}
  ]}' | jq '{version}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"baseline_run_id": "'"$BASELINE_RUN_ID"'", "wait": true}' \
  | jq '{decider_versions, reply_review: .aggregate_scores.scorers.reply_review}'
```

</TabItem>
</Tabs>

The baseline says `reply_review: 1`, the candidate `reply_review: 2`: a delta between them measures the agent and the criteria at once. Re-run the baseline under the new version before reading the delta as the agent's.

---

## Next Steps

- Gate a release on this eval: [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval).
- Branch production traffic on the same decider: [Route Work with a Decider](/docs/tutorials/route-work-with-a-decider).
- Compare with a free-text judge: [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers).
