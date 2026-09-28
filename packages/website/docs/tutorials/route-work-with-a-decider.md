---
description: "Route an orchestration on a decider's answer: a tool-backed decider applies refund rules to a customer record, and a condition node takes the branch it chose."
keywords:
  - deciders
  - decisions
  - orchestration routing
  - rule engine
  - condition nodes
sidebar_position: 32
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Route Work with a Decider

An orchestration that asks a [decider](/docs/modules/deciders) whether to pay a refund now or send it to a person, then takes the branch the decider chose. The decider is answered by a [pipeline tool](/docs/modules/tools#pipeline) that reads the customer's record and applies two rules: a refund of 50 or less is paid, and so is any refund for a gold customer. No AI provider is required.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration) for condition nodes.
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.

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

Every resource below belongs to one [project](/docs/modules/projects).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "refund-desk" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'refund-desk' },
});
const PROJECT_ID = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"refund-desk"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Store two customer records

Each customer is a [file](/docs/modules/files) under `/customers/` whose [metadata](/docs/modules/files#data-model) carries the tier the rules read.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RITA_ID=$(soat create-file \
  --project-id "$PROJECT_ID" \
  --prefix /customers \
  --filename rita.json \
  --content-type application/json \
  --metadata '{"tier": "standard"}' | jq -r '.id')

GIL_ID=$(soat create-file \
  --project-id "$PROJECT_ID" \
  --prefix /customers \
  --filename gil.json \
  --content-type application/json \
  --metadata '{"tier": "gold"}' | jq -r '.id')
echo "Rita: $RITA_ID  Gil: $GIL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: rita } = await adminSoat.files.createFile({
  body: {
    project_id: PROJECT_ID,
    prefix: '/customers',
    filename: 'rita.json',
    content_type: 'application/json',
    metadata: { tier: 'standard' },
  },
});
const { data: gil } = await adminSoat.files.createFile({
  body: {
    project_id: PROJECT_ID,
    prefix: '/customers',
    filename: 'gil.json',
    content_type: 'application/json',
    metadata: { tier: 'gold' },
  },
});
const RITA_ID = rita!.id;
const GIL_ID = gil!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RITA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","prefix":"/customers","filename":"rita.json","content_type":"application/json","metadata":{"tier":"standard"}}' \
  | jq -r '.id')

GIL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","prefix":"/customers","filename":"gil.json","content_type":"application/json","metadata":{"tier":"gold"}}' \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Write the refund rules as a pipeline

A decider sends its tool `{ state, questions }` and reads back `{ answers }` ([The tool backend](/docs/modules/deciders#the-tool-backend)). This pipeline reads the customer named in the state with a builtin `get-file` step, then builds the answer in its `output`: `approve` when the amount is 50 or less or the tier is `gold`, `review` otherwise.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RULES_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name refund-rules \
  --type pipeline \
  --description "Pays small refunds and any refund for a gold customer" \
  --pipeline '{
    "steps": [
      {
        "id": "customer",
        "tool": {"name": "read-customer", "type": "builtin", "actions": ["get-file"]},
        "action": "get-file",
        "input": {"file_id": {"var": "input.state.customer_id"}}
      }
    ],
    "output": {
      "answers": {
        "route": {
          "choice": {
            "if": [
              {"or": [
                {"<=": [{"var": "input.state.amount"}, 50]},
                {"==": [{"var": "steps.customer.metadata.tier"}, "gold"]}
              ]},
              "approve",
              "review"
            ]
          }
        }
      }
    }
  }' | jq -r '.id')
echo "Rules: $RULES_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: rules } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'refund-rules',
    type: 'pipeline',
    description: 'Pays small refunds and any refund for a gold customer',
    pipeline: {
      steps: [
        {
          id: 'customer',
          tool: { name: 'read-customer', type: 'builtin', actions: ['get-file'] },
          action: 'get-file',
          input: { file_id: { var: 'input.state.customer_id' } },
        },
      ],
      output: {
        answers: {
          route: {
            choice: {
              if: [
                {
                  or: [
                    { '<=': [{ var: 'input.state.amount' }, 50] },
                    { '==': [{ var: 'steps.customer.metadata.tier' }, 'gold'] },
                  ],
                },
                'approve',
                'review',
              ],
            },
          },
        },
      },
    },
  },
});
const RULES_ID = rules!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RULES_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "refund-rules",
    "type": "pipeline",
    "description": "Pays small refunds and any refund for a gold customer",
    "pipeline": {
      "steps": [
        {"id":"customer","tool":{"name":"read-customer","type":"builtin","actions":["get-file"]},"action":"get-file","input":{"file_id":{"var":"input.state.customer_id"}}}
      ],
      "output": {
        "answers": {
          "route": {
            "choice": {"if":[{"or":[{"<=":[{"var":"input.state.amount"},50]},{"==":[{"var":"steps.customer.metadata.tier"},"gold"]}]},"approve","review"]}
          }
        }
      }
    }
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

The `get-file` step runs as whoever requested the decision, so it reads only the records that caller may read.

---

## Step 5 — Create the decider

The decider holds one `choice` [question](/docs/modules/deciders#questions) and names the pipeline as its backend with `tool_id`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DECIDER_ID=$(soat create-decider \
  --project-id "$PROJECT_ID" \
  --name refund-route \
  --tool-id "$RULES_ID" \
  --questions '{
    "route": {
      "type": "choice",
      "instructions": "Pay this refund now, or send it to a person?",
      "criteria": {
        "approve": "Pay the refund now",
        "review": "A person checks it first"
      }
    }
  }' | jq -r '.id')
echo "Decider: $DECIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: decider } = await adminSoat.deciders.createDecider({
  body: {
    project_id: PROJECT_ID,
    name: 'refund-route',
    tool_id: RULES_ID,
    questions: {
      route: {
        type: 'choice',
        instructions: 'Pay this refund now, or send it to a person?',
        criteria: {
          approve: 'Pay the refund now',
          review: 'A person checks it first',
        },
      },
    },
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
    "name": "refund-route",
    "tool_id": "'"$RULES_ID"'",
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "Pay this refund now, or send it to a person?",
        "criteria": {"approve": "Pay the refund now", "review": "A person checks it first"}
      }
    }
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 6 — Let the orchestration request decisions

An orchestration reaches the decider through a [builtin tool](/docs/modules/tools#data-model) that exposes the `create-decision` action.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DECIDE_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name request-decision \
  --type builtin \
  --description "Requests a decision from a decider" \
  --actions '["create-decision"]' | jq -r '.id')
echo "Decide tool: $DECIDE_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: decideTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'request-decision',
    type: 'builtin',
    description: 'Requests a decision from a decider',
    actions: ['create-decision'],
  },
});
const DECIDE_TOOL_ID = decideTool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DECIDE_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"request-decision","type":"builtin","description":"Requests a decision from a decider","actions":["create-decision"]}' \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 7 — Create the orchestration

| Node | Type | Purpose |
|---|---|---|
| `decide` | `tool` | Requests a decision on the refund in the run input |
| `route` | `condition` | Emits the decider's `route` answer as its label |
| `pay` | `transform` | Runs on the `approve` branch |
| `escalate` | `transform` | Runs on the `review` branch |

A [tool call waits for its decision](/docs/advanced/sync-and-async#two-combinations-that-are-resolved-for-you), so `decide`'s artifact is the settled [decision](/docs/modules/deciders#requesting-a-decision), and `route` reads the answer at `nodes.decide.answers.route.choice` ([The `nodes.<id>` namespace](/docs/modules/orchestrations#the-nodesid-namespace)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name refund-desk \
  --nodes '[
    {
      "id": "decide",
      "type": "tool",
      "tool_id": "'"$DECIDE_TOOL_ID"'",
      "operation_id": "create-decision",
      "input_mapping": {
        "decider_id": "'"$DECIDER_ID"'",
        "state": {"customer_id": {"var": "input.customer_id"}, "amount": {"var": "input.amount"}}
      }
    },
    {"id": "route", "type": "condition", "expression": {"var": "nodes.decide.answers.route.choice"}},
    {
      "id": "pay",
      "type": "transform",
      "expression": {"cat": ["PAID ", {"var": "input.amount"}]},
      "state_mapping": {"state.result": {"var": "output.result"}}
    },
    {
      "id": "escalate",
      "type": "transform",
      "expression": {"cat": ["REVIEW ", {"var": "input.amount"}]},
      "state_mapping": {"state.result": {"var": "output.result"}}
    }
  ]' \
  --edges '[
    {"from": "decide", "to": "route"},
    {"from": "route", "to": "pay", "condition": "approve"},
    {"from": "route", "to": "escalate", "condition": "review"}
  ]' | jq -r '.id')
echo "Orchestration: $ORCH_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orch } = await adminSoat.orchestrations.createOrchestration({
  body: {
    project_id: PROJECT_ID,
    name: 'refund-desk',
    nodes: [
      {
        id: 'decide',
        type: 'tool',
        tool_id: DECIDE_TOOL_ID,
        operation_id: 'create-decision',
        input_mapping: {
          decider_id: DECIDER_ID,
          state: {
            customer_id: { var: 'input.customer_id' },
            amount: { var: 'input.amount' },
          },
        },
      },
      {
        id: 'route',
        type: 'condition',
        expression: { var: 'nodes.decide.answers.route.choice' },
      },
      {
        id: 'pay',
        type: 'transform',
        expression: { cat: ['PAID ', { var: 'input.amount' }] },
        state_mapping: { 'state.result': { var: 'output.result' } },
      },
      {
        id: 'escalate',
        type: 'transform',
        expression: { cat: ['REVIEW ', { var: 'input.amount' }] },
        state_mapping: { 'state.result': { var: 'output.result' } },
      },
    ],
    edges: [
      { from: 'decide', to: 'route' },
      { from: 'route', to: 'pay', condition: 'approve' },
      { from: 'route', to: 'escalate', condition: 'review' },
    ],
  },
});
const ORCH_ID = orch!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCH_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "refund-desk",
    "nodes": [
      {"id":"decide","type":"tool","tool_id":"'"$DECIDE_TOOL_ID"'","operation_id":"create-decision","input_mapping":{"decider_id":"'"$DECIDER_ID"'","state":{"customer_id":{"var":"input.customer_id"},"amount":{"var":"input.amount"}}}},
      {"id":"route","type":"condition","expression":{"var":"nodes.decide.answers.route.choice"}},
      {"id":"pay","type":"transform","expression":{"cat":["PAID ",{"var":"input.amount"}]},"state_mapping":{"state.result":{"var":"output.result"}}},
      {"id":"escalate","type":"transform","expression":{"cat":["REVIEW ",{"var":"input.amount"}]},"state_mapping":{"state.result":{"var":"output.result"}}}
    ],
    "edges": [
      {"from":"decide","to":"route"},
      {"from":"route","to":"pay","condition":"approve"},
      {"from":"route","to":"escalate","condition":"review"}
    ]
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 8 — Route three refunds

Rita's 30 is under the limit and is paid; her 400 is sent to review; Gil's 400 is paid because he is gold. Each run blocks until it settles ([Start a run](/docs/modules/orchestrations#start-a-run)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SMALL_RUN=$(soat start-orchestration-run --orchestration-id "$ORCH_ID" \
  --input '{"customer_id": "'"$RITA_ID"'", "amount": 30}' --wait true)
LARGE_RUN=$(soat start-orchestration-run --orchestration-id "$ORCH_ID" \
  --input '{"customer_id": "'"$RITA_ID"'", "amount": 400}' --wait true)
GOLD_RUN=$(soat start-orchestration-run --orchestration-id "$ORCH_ID" \
  --input '{"customer_id": "'"$GIL_ID"'", "amount": 400}' --wait true)

SUMMARY='{status, route: .state.nodes.decide.answers.route.choice, result: .state.result}'
echo "$SMALL_RUN" | jq -c "$SUMMARY"
echo "$LARGE_RUN" | jq -c "$SUMMARY"
echo "$GOLD_RUN" | jq -c "$SUMMARY"
```

Expected output:

```json
{"status":"succeeded","route":"approve","result":"PAID 30"}
{"status":"succeeded","route":"review","result":"REVIEW 400"}
{"status":"succeeded","route":"approve","result":"PAID 400"}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const runs = [
  { customer_id: RITA_ID, amount: 30 },
  { customer_id: RITA_ID, amount: 400 },
  { customer_id: GIL_ID, amount: 400 },
];

for (const input of runs) {
  const { data: run } = await adminSoat.orchestrations.startOrchestrationRun({
    body: { orchestration_id: ORCH_ID, input, wait: true },
  });
  console.log(run!.status, run!.state);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
for INPUT in \
  '{"customer_id":"'"$RITA_ID"'","amount":30}' \
  '{"customer_id":"'"$RITA_ID"'","amount":400}' \
  '{"customer_id":"'"$GIL_ID"'","amount":400}'; do
  curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"orchestration_id":"'"$ORCH_ID"'","input":'"$INPUT"',"wait":true}' \
    | jq -c '{status, route: .state.nodes.decide.answers.route.choice, result: .state.result}'
done
```

</TabItem>
</Tabs>

---

## Step 9 — Read the decision behind a run

Every run's `decide` artifact carries the decision's `id`; the decision is its own record, with the decider version that answered ([Decision](/docs/modules/deciders#decision)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DECISION_ID=$(echo "$LARGE_RUN" | jq -r '.state.nodes.decide.id')

soat get-decision --decision-id "$DECISION_ID" \
  | jq '{status, decider_id, decider_version, answers}'
```

Expected output:

```json
{
  "status": "completed",
  "decider_id": "dcd_…",
  "decider_version": 1,
  "answers": { "route": { "type": "choice", "choice": "review" } }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: largeRun } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCH_ID,
    input: { customer_id: RITA_ID, amount: 400 },
    wait: true,
  },
});
const decide = largeRun!.state?.nodes as { decide: { id: string } };

const { data: decision } = await adminSoat.deciders.getDecision({
  path: { decision_id: decide.decide.id },
});
console.log(decision!.answers);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DECISION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id":"'"$ORCH_ID"'","input":{"customer_id":"'"$RITA_ID"'","amount":400},"wait":true}' \
  | jq -r '.state.nodes.decide.id')

curl -s "$SOAT_BASE_URL/api/v1/decisions/$DECISION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, decider_id, decider_version, answers}'
```

</TabItem>
</Tabs>

---

## Next Steps

- Answer the same question with judgment instead of rules: point the decider at an agent with `agent_id` ([Backends](/docs/modules/deciders#backends)).
- Put a person on the `review` branch: [Approval Gate](/docs/tutorials/approval-gate).
