---
description: "Point a decider at OpenAI's Decisions API through an http tool: versioned questions in SOAT, calibrated probabilities from OpenAI, no adapter."
keywords:
  - deciders
  - OpenAI Decisions API
  - calibrated probabilities
  - http tools
  - secrets
sidebar_position: 34
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Answer a Decider with OpenAI's Decisions API

A support desk triages every ticket with three questions: is it a refund request, which department owns it, how urgent is it. A [decider](/docs/modules/deciders) named `ticket-triage` holds the questions, versioned; [OpenAI's Decisions API](https://developers.openai.com/api/docs/guides/decisions) answers them with probabilities rather than text.

The decider's questions, input and answers are the shapes of OpenAI's Decisions API, so an `http` tool that forwards to `/v1/decisions` answers the decider as it is: no pipeline, no mapping.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts).
- [Route Work with a Decider](/docs/tutorials/route-work-with-a-decider) for deciders and tool backends.
- An [OpenAI API key](https://platform.openai.com/api-keys). Not needed against the mock endpoint the tutorial tests run with.
- `api.openai.com` in [`TOOL_EGRESS_ALLOWED_HOSTS`](/docs/self-hosting/configuration) when your server restricts tool egress.
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1

# The default is the real endpoint; overridable so the tutorial also runs against a mock.
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-your-openai-key}"
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
PROJECT_ID=$(soat create-project --name "openai-triage" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'openai-triage' },
});
const PROJECT_ID = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"openai-triage"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Reach the Decisions API from a tool

The key goes in a [secret](/docs/modules/secrets), and the `http` tool names it by reference, so no read of the tool returns it. A decider calls its tool with `{ input, questions }`, the Decisions API request less `model`; `model` is pinned in [`preset_parameters`](/docs/modules/tools#preset-parameters), which are merged into every call.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SECRET_ID=$(soat create-secret --project-id "$PROJECT_ID" \
  --name openai-api-key --value "$OPENAI_API_KEY" | jq -r '.id')

OPENAI_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name openai-decisions \
  --type http \
  --description "OpenAI Decisions API" \
  --parameters '{"type":"object","properties":{"input":{},"questions":{"type":"array"}},"required":["input","questions"]}' \
  --execute '{
    "url": "'"$OPENAI_BASE_URL"'/decisions",
    "method": "POST",
    "headers": {"Authorization": "Bearer {{secret:'"$SECRET_ID"'}}"}
  }' \
  --preset-parameters '{"model": "gpt-6-luna"}' | jq -r '.id')
echo "OpenAI tool: $OPENAI_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: secret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-api-key',
    value: process.env.OPENAI_API_KEY!,
  },
});

const { data: openaiTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-decisions',
    type: 'http',
    description: 'OpenAI Decisions API',
    parameters: {
      type: 'object',
      properties: { input: {}, questions: { type: 'array' } },
      required: ['input', 'questions'],
    },
    execute: {
      url: `${process.env.OPENAI_BASE_URL}/decisions`,
      method: 'POST',
      headers: { Authorization: `Bearer {{secret:${secret!.id}}}` },
    },
    preset_parameters: { model: 'gpt-6-luna' },
  },
});
const OPENAI_TOOL_ID = openaiTool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"openai-api-key","value":"'"$OPENAI_API_KEY"'"}' \
  | jq -r '.id')

OPENAI_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "openai-decisions",
    "type": "http",
    "description": "OpenAI Decisions API",
    "parameters": {"type":"object","properties":{"input":{},"questions":{"type":"array"}},"required":["input","questions"]},
    "execute": {
      "url": "'"$OPENAI_BASE_URL"'/decisions",
      "method": "POST",
      "headers": {"Authorization": "Bearer {{secret:'"$SECRET_ID"'}}"}
    },
    "preset_parameters": {"model": "gpt-6-luna"}
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Create the decider

One question of each type the Decisions API answers. The decider stores them as version 1; every decision names the version it was answered under.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DECIDER_ID=$(soat create-decider \
  --project-id "$PROJECT_ID" \
  --name ticket-triage \
  --tool-id "$OPENAI_TOOL_ID" \
  --questions '[
    {
      "type": "predicate",
      "name": "refund_request",
      "instructions": "Is the customer asking for money back?"
    },
    {
      "type": "choice",
      "name": "department",
      "instructions": "Which department should handle this ticket?",
      "choices": [
        {"value": "billing", "description": "Payments, invoices and refunds."},
        {"value": "technical", "description": "Problems using the product."},
        {"value": "shipping", "description": "Delivery and tracking."}
      ]
    },
    {
      "type": "score",
      "name": "urgency",
      "instructions": "How urgent is this ticket?",
      "levels": [
        {"label": "Low", "description": "Can wait for the regular queue."},
        {"label": "Medium", "description": "Should be handled today."},
        {"label": "High", "description": "Blocks the customer right now."}
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
    name: 'refund_request',
    instructions: 'Is the customer asking for money back?',
  },
  {
    type: 'choice',
    name: 'department',
    instructions: 'Which department should handle this ticket?',
    choices: [
      { value: 'billing', description: 'Payments, invoices and refunds.' },
      { value: 'technical', description: 'Problems using the product.' },
      { value: 'shipping', description: 'Delivery and tracking.' },
    ],
  },
  {
    type: 'score',
    name: 'urgency',
    instructions: 'How urgent is this ticket?',
    levels: [
      { label: 'Low', description: 'Can wait for the regular queue.' },
      { label: 'Medium', description: 'Should be handled today.' },
      { label: 'High', description: 'Blocks the customer right now.' },
    ],
  },
];

const { data: decider } = await adminSoat.deciders.createDecider({
  body: {
    project_id: PROJECT_ID,
    name: 'ticket-triage',
    tool_id: OPENAI_TOOL_ID,
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
    "name": "ticket-triage",
    "tool_id": "'"$OPENAI_TOOL_ID"'",
    "questions": [
      {"type": "predicate", "name": "refund_request", "instructions": "Is the customer asking for money back?"},
      {"type": "choice", "name": "department", "instructions": "Which department should handle this ticket?", "choices": [
        {"value": "billing", "description": "Payments, invoices and refunds."},
        {"value": "technical", "description": "Problems using the product."},
        {"value": "shipping", "description": "Delivery and tracking."}
      ]},
      {"type": "score", "name": "urgency", "instructions": "How urgent is this ticket?", "levels": [
        {"label": "Low", "description": "Can wait for the regular queue."},
        {"label": "Medium", "description": "Should be handled today."},
        {"label": "High", "description": "Blocks the customer right now."}
      ]}
    ]
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 5 — Triage a ticket

Request a decision with [`POST /api/v1/deciders/{decider_id}/decisions`](/docs/api/deciders/create-decision). The ticket is the `input`; `metadata` keeps its id on the decision, since the input itself is not stored.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DECISION=$(soat create-decision \
  --decider-id "$DECIDER_ID" \
  --input "I was charged twice for order 1042. Please refund the duplicate." \
  --metadata '{"ticket_id": "ZD-1042"}' \
  --wait true)
echo "$DECISION" | jq '{status, decider_version, answers}'
test "$(echo "$DECISION" | jq -r '.status')" = "completed"
```

Expected output against the mock (OpenAI's own figures vary):

```json
{
  "status": "completed",
  "decider_version": 1,
  "answers": [
    { "type": "predicate", "name": "refund_request", "probability": 0.92 },
    {
      "type": "choice",
      "name": "department",
      "choice": "billing",
      "probabilities": [
        { "value": "billing", "probability": 0.9 },
        { "value": "technical", "probability": 0.05 },
        { "value": "shipping", "probability": 0.05 }
      ],
      "confidence": 0.88
    },
    {
      "type": "score",
      "name": "urgency",
      "score": 1,
      "probabilities": [
        { "value": 0, "label": "Low", "probability": 0.15 },
        { "value": 1, "label": "Medium", "probability": 0.7 },
        { "value": 2, "label": "High", "probability": 0.15 }
      ],
      "confidence": 0.55
    }
  ]
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: decision } = await adminSoat.deciders.createDecision({
  path: { decider_id: DECIDER_ID },
  body: {
    input: 'I was charged twice for order 1042. Please refund the duplicate.',
    metadata: { ticket_id: 'ZD-1042' },
    wait: true,
  },
});
console.log(decision!.status, decision!.answers);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/deciders/$DECIDER_ID/decisions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "I was charged twice for order 1042. Please refund the duplicate.",
    "metadata": {"ticket_id": "ZD-1042"},
    "wait": true
  }' | jq '{status, decider_version, answers}'
```

</TabItem>
</Tabs>

The answers are OpenAI's, validated against the decider's questions and stored in question order. `probability`, `probabilities` and `confidence` come from the Decisions API; a decider answered by an [agent](/docs/modules/deciders#the-agent-runs-tool-less) records a predicate as 1 or 0 and carries neither.

---

## Step 6 — Read an answer by name

The caller sets the threshold on `probability`. `answers_by_name` keys the same answers by question name, the path an [orchestration](/docs/modules/orchestrations) condition or a JSON Logic expression reads.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
echo "$DECISION" | jq '{
  refund: (.answers_by_name.refund_request.probability >= 0.8),
  department: .answers_by_name.department.choice,
  urgency: .answers_by_name.urgency.score
}'
```

Expected output against the mock:

```json
{ "refund": true, "department": "billing", "urgency": 1 }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const byName = decision!.answers_by_name!;
console.log({
  refund: byName.refund_request.probability! >= 0.8,
  department: byName.department.choice,
  urgency: byName.urgency.score,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/decisions?project_id=$PROJECT_ID&decider_id=$DECIDER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[0].answers_by_name | {
      refund: (.refund_request.probability >= 0.8),
      department: .department.choice,
      urgency: .urgency.score
    }'
```

</TabItem>
</Tabs>

---

## Step 7 — Ask once, without a decider

For a one-off question, [`POST /api/v1/decisions`](/docs/api/deciders/create-inline-decision) takes the questions with the request, the way OpenAI's endpoint does, and names the tool in place of `model`. The decision carries its own `questions` and no `decider_id`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
INLINE=$(soat create-inline-decision \
  --project-id "$PROJECT_ID" \
  --tool-id "$OPENAI_TOOL_ID" \
  --questions '[{"type": "predicate", "name": "abusive", "instructions": "Is the message abusive toward the agent?"}]' \
  --input "Thanks for the quick help!" \
  --wait true)
echo "$INLINE" | jq '{status, decider_id, answers}'
test "$(echo "$INLINE" | jq -r '.status')" = "completed"
```

Expected output against the mock:

```json
{
  "status": "completed",
  "decider_id": null,
  "answers": [{ "type": "predicate", "name": "abusive", "probability": 0.92 }]
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: inline } = await adminSoat.deciders.createInlineDecision({
  body: {
    project_id: PROJECT_ID,
    tool_id: OPENAI_TOOL_ID,
    questions: [
      {
        type: 'predicate',
        name: 'abusive',
        instructions: 'Is the message abusive toward the agent?',
      },
    ],
    input: 'Thanks for the quick help!',
    wait: true,
  },
});
console.log(inline!.answers);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/decisions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "tool_id": "'"$OPENAI_TOOL_ID"'",
    "questions": [{"type": "predicate", "name": "abusive", "instructions": "Is the message abusive toward the agent?"}],
    "input": "Thanks for the quick help!",
    "wait": true
  }' | jq '{status, decider_id, answers}'
```

</TabItem>
</Tabs>

An `input` may also be a list of `user` messages with `input_text` and base64 `input_image` parts, as on OpenAI's endpoint; the tool forwards it unchanged.

---

## What the tool path costs

- A decision answered this way is metered as a `tool_execution` event with `source: decider`, not as a generation: OpenAI's token cost does not appear on SOAT's generation receipts.
- An error from OpenAI, such as a `401` for a bad key or a `429`, settles the decision `failed` with the tool's code. Failure is terminal: request a new decision.
- An answer outside the questions settles it `failed` with `DECISION_ANSWER_INVALID` ([The tool backend](/docs/modules/deciders#the-tool-backend)).

---

## Next Steps

- Branch an orchestration on the answer: [Route Work with a Decider](/docs/tutorials/route-work-with-a-decider).
- Grade an eval with the same decider: [Grade an Eval with a Decider](/docs/tutorials/grade-an-eval-with-a-decider).
- Bridge an engine that speaks a neighbouring shape: [Bridging an engine with a pipeline](/docs/modules/deciders#bridging-an-engine-with-a-pipeline).
