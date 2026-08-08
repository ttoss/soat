---
description: "Compose an orchestration, a workflow, a trigger, and an approval into one governed month-end close process."
keywords:
  - month-end close
  - financial reconciliation
  - AI agent workflow
  - approval gate
  - deterministic orchestration
sidebar_position: 25
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Close the Monthly Books

Every company closes its books. The process is a good fit for SOAT because it is
made of parts that belong to different layers, and this tutorial is where those
layers meet:

- The **reconciliation pass** is a pipeline that runs and ends — an
  [orchestration](/docs/modules/orchestrations). Several accounts reconcile in
  parallel, the variances converge, and a branch decides what happens next.
- The **close period** is an entity that lives for days and can move *backward*
  when the controller sends it back — a [workflow](/docs/modules/workflows).
- The **cadence** is the first of the month — a
  [trigger](/docs/modules/triggers).
- The **sign-off** is a human decision recorded for audit — an
  [approval](/docs/modules/approvals).

The single most important design choice here is *where the model sits*. Every
routing decision in the graph is arithmetic evaluated by
[JSON Logic](https://jsonlogic.com) — whether a variance clears tolerance is a
subtraction and a comparison, not a judgement. The [agent](/docs/modules/agents)
is used for exactly one thing the arithmetic cannot do: writing the controller a
readable note about what to investigate. The books never depend on what a model
decides.

You will:

1. Build a reconciliation orchestration whose branch is decided by arithmetic.
2. Run it clean, then run it against books that do not balance.
3. Put it on a monthly schedule with a trigger.
4. Model the close period as a workflow with a backward transition.
5. Close the period behind a guard **and** a human approval, then read the audit
   trail.

This tutorial assumes you already know how a graph is wired. If you do not, read
[Conditional Branching](/docs/tutorials/conditional-orchestration) and
[Orchestration Control Flow](/docs/tutorials/orchestration-control-flow) first —
this one composes those pieces rather than re-teaching them.

> The figures here are fixtures chosen to make the arithmetic legible. This
> tutorial teaches the mechanics of a governed process; it is not accounting
> guidance, and a real close would pull balances from your ledger through
> [tool](/docs/modules/tools) nodes instead of run input.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) for projects, agents, orchestrations, and tasks.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- [Ollama](https://ollama.com) reachable by the server, for the one agent node.
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

## Step 2 — Create a project

Every resource below lives inside one [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Monthly Close" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Monthly Close' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Monthly Close"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the AI provider and the variance-memo agent

One [AI provider](/docs/modules/ai-providers#examples) and one
[agent](/docs/modules/agents#examples). The agent's whole job is to turn a number
into a sentence a controller can act on — it never decides whether the books
balance.

Note what the agent does **not** have: an `output_schema`. Nothing downstream
parses its text, so a weaker model cannot break the graph. That is the general
rule for putting a model inside a deterministic process — give it the last word
on wording, never on control flow.

This tutorial uses a local Ollama provider so it can run without external
credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see
[Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"

MEMO_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Variance Memo Agent" \
  --instructions 'You are an accounting assistant. You receive a period and an unreconciled variance. Reply with two plain sentences telling the controller what to investigate first. No markdown, no headings, no lists.' \
  --max-steps 1 | jq -r '.id')
echo "MEMO_AGENT_ID: $MEMO_AGENT_ID"
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

const { data: memoAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Variance Memo Agent',
    instructions:
      'You are an accounting assistant. You receive a period and an unreconciled variance. Reply with two plain sentences telling the controller what to investigate first. No markdown, no headings, no lists.',
    max_steps: 1,
  },
});
const MEMO_AGENT_ID = memoAgent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Local Ollama","provider":"ollama","default_model":"qwen2.5:0.5b"}' \
  | jq -r '.id')

MEMO_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","ai_provider_id":"'"$AI_PROVIDER_ID"'","name":"Variance Memo Agent","instructions":"You are an accounting assistant. You receive a period and an unreconciled variance. Reply with two plain sentences telling the controller what to investigate first. No markdown, no headings, no lists.","max_steps":1}' \
  | jq -r '.id')
echo "MEMO_AGENT_ID: $MEMO_AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Validate and create the reconciliation graph

Seven nodes. Three reconciliations have no incoming edges, so they are all start
nodes and run in the same round — in parallel. Their edges share an
`activation_group` with `activation_condition: "all"`, which makes
`total_variance` a **join barrier**: it waits for all three.

```txt
  bank_recon ─┐
  ar_recon   ─┼─(all)─► total_variance ─► gate_check ─┬─clean──────► clean_summary
  ap_recon   ─┘                                       └─exception──► draft_memo
```

| Node | Type | Purpose |
|---|---|---|
| `bank_recon` | `transform` | Absolute difference between ledger cash and the bank statement |
| `ar_recon` | `transform` | Absolute difference between the AR control account and its subledger |
| `ap_recon` | `transform` | Absolute difference between the AP control account and its subledger |
| `total_variance` | `transform` | Sums the three variances once all have landed |
| `gate_check` | `condition` | Emits `"clean"` or `"exception"` by comparing the total against tolerance |
| `clean_summary` | `transform` | The `clean` branch — records that the period tied out |
| `draft_memo` | `agent` | The `exception` branch — writes the controller a note |

Two things to notice in the JSON Logic. First, JSON Logic has no absolute-value
operator, so each reconciliation uses `if` to pick whichever subtraction order is
positive. Second, **run input and run state are different namespaces**: read
input as `{"var": "input.tolerance"}`, and read a state key an upstream node
wrote as a bare `{"var": "total_variance"}`. A flat reference is never satisfied
by run input, which is why the two forms are not interchangeable.

`validate-orchestration` statically checks the graph — unique ids, edges that
resolve, acyclicity, and every `{"var": ...}` reference reachable from an
upstream writer — without persisting anything. Run it before you create, and
again in CI whenever a graph changes. See
[Orchestrations](/docs/modules/orchestrations#node-types) for the full node
reference.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CLOSE_NODES='[
  { "id": "bank_recon", "type": "transform",
    "expression": { "if": [
      { "<": [ { "-": [ { "var": "input.ledger.cash" }, { "var": "input.statements.bank" } ] }, 0 ] },
      { "-": [ { "var": "input.statements.bank" }, { "var": "input.ledger.cash" } ] },
      { "-": [ { "var": "input.ledger.cash" }, { "var": "input.statements.bank" } ] } ] },
    "state_mapping": { "state.bank_variance": { "var": "output.result" } } },
  { "id": "ar_recon", "type": "transform",
    "expression": { "if": [
      { "<": [ { "-": [ { "var": "input.ledger.ar" }, { "var": "input.statements.ar_subledger" } ] }, 0 ] },
      { "-": [ { "var": "input.statements.ar_subledger" }, { "var": "input.ledger.ar" } ] },
      { "-": [ { "var": "input.ledger.ar" }, { "var": "input.statements.ar_subledger" } ] } ] },
    "state_mapping": { "state.ar_variance": { "var": "output.result" } } },
  { "id": "ap_recon", "type": "transform",
    "expression": { "if": [
      { "<": [ { "-": [ { "var": "input.ledger.ap" }, { "var": "input.statements.ap_subledger" } ] }, 0 ] },
      { "-": [ { "var": "input.statements.ap_subledger" }, { "var": "input.ledger.ap" } ] },
      { "-": [ { "var": "input.ledger.ap" }, { "var": "input.statements.ap_subledger" } ] } ] },
    "state_mapping": { "state.ap_variance": { "var": "output.result" } } },
  { "id": "total_variance", "type": "transform",
    "expression": { "+": [ { "var": "bank_variance" }, { "var": "ar_variance" }, { "var": "ap_variance" } ] },
    "state_mapping": { "state.total_variance": { "var": "output.result" } } },
  { "id": "gate_check", "type": "condition",
    "expression": { "if": [ { "<=": [ { "var": "total_variance" }, { "var": "input.tolerance" } ] }, "clean", "exception" ] } },
  { "id": "clean_summary", "type": "transform",
    "expression": { "cat": [ "Period ", { "var": "input.period" }, " tied out within tolerance." ] },
    "state_mapping": { "state.close_note": { "var": "output.result" } } },
  { "id": "draft_memo", "type": "agent", "agent_id": "'"$MEMO_AGENT_ID"'",
    "input_mapping": { "prompt": { "cat": [ "Period ", { "var": "input.period" }, " has an unreconciled variance of ", { "var": "total_variance" }, " USD across bank, AR and AP." ] } },
    "state_mapping": { "state.memo": { "var": "output.content" } } }
]'

CLOSE_EDGES='[
  { "from": "bank_recon", "to": "total_variance", "activation_group": "recon", "activation_condition": "all" },
  { "from": "ar_recon", "to": "total_variance", "activation_group": "recon", "activation_condition": "all" },
  { "from": "ap_recon", "to": "total_variance", "activation_group": "recon", "activation_condition": "all" },
  { "from": "total_variance", "to": "gate_check" },
  { "from": "gate_check", "to": "clean_summary", "condition": "clean" },
  { "from": "gate_check", "to": "draft_memo", "condition": "exception" }
]'

soat validate-orchestration --nodes "$CLOSE_NODES" --edges "$CLOSE_EDGES" \
  | jq '{valid, errors, warnings}'

CLOSE_ORCH_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Month-End Reconciliation" \
  --description "Reconciles bank, AR and AP in parallel and routes on total variance" \
  --nodes "$CLOSE_NODES" \
  --edges "$CLOSE_EDGES" | jq -r '.id')
echo "CLOSE_ORCH_ID: $CLOSE_ORCH_ID"
```

Expected validation output:

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const closeNodes = [
  {
    id: 'bank_recon',
    type: 'transform',
    expression: {
      if: [
        {
          '<': [
            {
              '-': [
                { var: 'input.ledger.cash' },
                { var: 'input.statements.bank' },
              ],
            },
            0,
          ],
        },
        {
          '-': [{ var: 'input.statements.bank' }, { var: 'input.ledger.cash' }],
        },
        {
          '-': [{ var: 'input.ledger.cash' }, { var: 'input.statements.bank' }],
        },
      ],
    },
    state_mapping: { 'state.bank_variance': { var: 'output.result' } },
  },
  {
    id: 'ar_recon',
    type: 'transform',
    expression: {
      if: [
        {
          '<': [
            {
              '-': [
                { var: 'input.ledger.ar' },
                { var: 'input.statements.ar_subledger' },
              ],
            },
            0,
          ],
        },
        {
          '-': [
            { var: 'input.statements.ar_subledger' },
            { var: 'input.ledger.ar' },
          ],
        },
        {
          '-': [
            { var: 'input.ledger.ar' },
            { var: 'input.statements.ar_subledger' },
          ],
        },
      ],
    },
    state_mapping: { 'state.ar_variance': { var: 'output.result' } },
  },
  {
    id: 'ap_recon',
    type: 'transform',
    expression: {
      if: [
        {
          '<': [
            {
              '-': [
                { var: 'input.ledger.ap' },
                { var: 'input.statements.ap_subledger' },
              ],
            },
            0,
          ],
        },
        {
          '-': [
            { var: 'input.statements.ap_subledger' },
            { var: 'input.ledger.ap' },
          ],
        },
        {
          '-': [
            { var: 'input.ledger.ap' },
            { var: 'input.statements.ap_subledger' },
          ],
        },
      ],
    },
    state_mapping: { 'state.ap_variance': { var: 'output.result' } },
  },
  {
    id: 'total_variance',
    type: 'transform',
    expression: {
      '+': [
        { var: 'bank_variance' },
        { var: 'ar_variance' },
        { var: 'ap_variance' },
      ],
    },
    state_mapping: { 'state.total_variance': { var: 'output.result' } },
  },
  {
    id: 'gate_check',
    type: 'condition',
    expression: {
      if: [
        { '<=': [{ var: 'total_variance' }, { var: 'input.tolerance' }] },
        'clean',
        'exception',
      ],
    },
  },
  {
    id: 'clean_summary',
    type: 'transform',
    expression: {
      cat: ['Period ', { var: 'input.period' }, ' tied out within tolerance.'],
    },
    state_mapping: { 'state.close_note': { var: 'output.result' } },
  },
  {
    id: 'draft_memo',
    type: 'agent',
    agent_id: MEMO_AGENT_ID,
    input_mapping: {
      prompt: {
        cat: [
          'Period ',
          { var: 'input.period' },
          ' has an unreconciled variance of ',
          { var: 'total_variance' },
          ' USD across bank, AR and AP.',
        ],
      },
    },
    state_mapping: { 'state.memo': { var: 'output.content' } },
  },
];

const closeEdges = [
  {
    from: 'bank_recon',
    to: 'total_variance',
    activation_group: 'recon',
    activation_condition: 'all',
  },
  {
    from: 'ar_recon',
    to: 'total_variance',
    activation_group: 'recon',
    activation_condition: 'all',
  },
  {
    from: 'ap_recon',
    to: 'total_variance',
    activation_group: 'recon',
    activation_condition: 'all',
  },
  { from: 'total_variance', to: 'gate_check' },
  { from: 'gate_check', to: 'clean_summary', condition: 'clean' },
  { from: 'gate_check', to: 'draft_memo', condition: 'exception' },
];

const { data: validation } =
  await adminSoat.orchestrations.validateOrchestration({
    body: { nodes: closeNodes, edges: closeEdges },
  });
console.log('Valid:', validation.valid, validation.errors);

const { data: closeOrch } =
  await adminSoat.orchestrations.createOrchestration({
    body: {
      project_id: PROJECT_ID,
      name: 'Month-End Reconciliation',
      description:
        'Reconciles bank, AR and AP in parallel and routes on total variance',
      nodes: closeNodes,
      edges: closeEdges,
    },
  });
const CLOSE_ORCH_ID = closeOrch.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# The nodes/edges JSON is identical to the CLI tab; keep it in files to stay readable.
curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations/validate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"nodes":'"$CLOSE_NODES"',"edges":'"$CLOSE_EDGES"'}' \
  | jq '{valid, errors, warnings}'

CLOSE_ORCH_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Month-End Reconciliation","description":"Reconciles bank, AR and AP in parallel and routes on total variance","nodes":'"$CLOSE_NODES"',"edges":'"$CLOSE_EDGES"'}' \
  | jq -r '.id')
echo "CLOSE_ORCH_ID: $CLOSE_ORCH_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Run a clean close

Start a [run](/docs/modules/orchestrations#examples) with books that balance. All
three reconciliations return `0`, the total is `0`, and `0 <= 1` routes down the
`clean` edge. `draft_memo` is never reached, so it is recorded as `skipped` — no
model was called at all on this path.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CLEAN_RUN=$(soat start-orchestration-run \
  --orchestration-id "$CLOSE_ORCH_ID" \
  --input '{
    "period": "2026-07",
    "ledger": { "cash": 128450.25, "ar": 64200.00, "ap": 31775.50 },
    "statements": { "bank": 128450.25, "ar_subledger": 64200.00, "ap_subledger": 31775.50 },
    "tolerance": 1
  }')

printf '%s\n' "$CLEAN_RUN" | jq '{status, total_variance: .state.total_variance, close_note: .state.close_note}'
printf '%s\n' "$CLEAN_RUN" | jq '[.node_executions[] | {node_id, status}]'
```

Expected output:

```json
{
  "status": "succeeded",
  "total_variance": 0,
  "close_note": "Period 2026-07 tied out within tolerance."
}
```

`draft_memo` appears with `"status": "skipped"`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: cleanRun } =
  await adminSoat.orchestrations.startOrchestrationRun({
    body: {
      orchestration_id: CLOSE_ORCH_ID,
      input: {
        period: '2026-07',
        ledger: { cash: 128450.25, ar: 64200.0, ap: 31775.5 },
        statements: {
          bank: 128450.25,
          ar_subledger: 64200.0,
          ap_subledger: 31775.5,
        },
        tolerance: 1,
      },
    },
  });

console.log('Status:', cleanRun.status);
console.log('Total variance:', cleanRun.state.total_variance);
console.log('Note:', cleanRun.state.close_note);
console.log(cleanRun.node_executions.map((n) => [n.node_id, n.status]));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CLEAN_RUN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id":"'"$CLOSE_ORCH_ID"'","input":{"period":"2026-07","ledger":{"cash":128450.25,"ar":64200.00,"ap":31775.50},"statements":{"bank":128450.25,"ar_subledger":64200.00,"ap_subledger":31775.50},"tolerance":1}}')

printf '%s\n' "$CLEAN_RUN" | jq '{status, total_variance: .state.total_variance, close_note: .state.close_note}'
```

</TabItem>
</Tabs>

---

## Step 6 — Run a close that finds a variance

Same graph, one changed figure: the bank statement is `127200.25` against ledger
cash of `128450.25`. `bank_recon` returns `1250`, the total exceeds the
tolerance of `1`, and `gate_check` routes down `exception` — so the
[agent](/docs/modules/agents#examples) runs and writes the memo. This time
`clean_summary` is the skipped node.

The variance is computed, not judged. Change the tolerance or the figures and the
branch changes with them, identically on every run.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
EXCEPTION_RUN=$(soat start-orchestration-run \
  --orchestration-id "$CLOSE_ORCH_ID" \
  --input '{
    "period": "2026-08",
    "ledger": { "cash": 128450.25, "ar": 64200.00, "ap": 31775.50 },
    "statements": { "bank": 127200.25, "ar_subledger": 64200.00, "ap_subledger": 31775.50 },
    "tolerance": 1
  }')

printf '%s\n' "$EXCEPTION_RUN" | jq '{status, bank_variance: .state.bank_variance, total_variance: .state.total_variance}'

# The memo is free text from the model — its wording varies, its presence does not.
printf '%s\n' "$EXCEPTION_RUN" | jq -r '.state.memo'

EXCEPTION_VARIANCE=$(printf '%s\n' "$EXCEPTION_RUN" | jq -r '.state.total_variance')
echo "EXCEPTION_VARIANCE: $EXCEPTION_VARIANCE"
```

Expected output:

```json
{
  "status": "succeeded",
  "bank_variance": 1250,
  "total_variance": 1250
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: exceptionRun } =
  await adminSoat.orchestrations.startOrchestrationRun({
    body: {
      orchestration_id: CLOSE_ORCH_ID,
      input: {
        period: '2026-08',
        ledger: { cash: 128450.25, ar: 64200.0, ap: 31775.5 },
        statements: {
          bank: 127200.25,
          ar_subledger: 64200.0,
          ap_subledger: 31775.5,
        },
        tolerance: 1,
      },
    },
  });

console.log('Bank variance:', exceptionRun.state.bank_variance); // 1250
console.log('Memo:', exceptionRun.state.memo);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
EXCEPTION_RUN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id":"'"$CLOSE_ORCH_ID"'","input":{"period":"2026-08","ledger":{"cash":128450.25,"ar":64200.00,"ap":31775.50},"statements":{"bank":127200.25,"ar_subledger":64200.00,"ap_subledger":31775.50},"tolerance":1}}')

printf '%s\n' "$EXCEPTION_RUN" | jq '{status, bank_variance: .state.bank_variance, total_variance: .state.total_variance}'
printf '%s\n' "$EXCEPTION_RUN" | jq -r '.state.memo'
```

</TabItem>
</Tabs>

---

## Step 7 — Put the close on a schedule

A close has a cadence, which makes it the natural home for a
[trigger](/docs/modules/triggers#examples). Create a `manual` trigger to fire the
pass on demand, and a `schedule` trigger for 02:00 UTC on the first of each
month. Firing returns a terminal firing record whose `result.result_id` is the
orchestration run it started.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MANUAL_TRIGGER_ID=$(soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name "run-close-now" \
  --type manual \
  --target-type orchestration \
  --target-id "$CLOSE_ORCH_ID" \
  --input '{
    "ledger": { "cash": 128450.25, "ar": 64200.00, "ap": 31775.50 },
    "statements": { "bank": 128450.25, "ar_subledger": 64200.00, "ap_subledger": 31775.50 },
    "tolerance": 1
  }' | jq -r '.id')

FIRING=$(soat fire-trigger --trigger-id "$MANUAL_TRIGGER_ID" --input '{"period":"2026-09"}')
printf '%s\n' "$FIRING" | jq '{status, result}'

# 02:00 UTC on the 1st of every month. The scheduler fires this one; you do not.
MONTHLY_TRIGGER_ID=$(soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name "month-end-close" \
  --type schedule \
  --target-type orchestration \
  --target-id "$CLOSE_ORCH_ID" \
  --cron "0 2 1 * *" \
  --input '{
    "ledger": { "cash": 128450.25, "ar": 64200.00, "ap": 31775.50 },
    "statements": { "bank": 128450.25, "ar_subledger": 64200.00, "ap_subledger": 31775.50 },
    "tolerance": 1
  }' | jq -r '.id')

soat get-trigger --trigger-id "$MONTHLY_TRIGGER_ID" | jq '{name, cron, next_fire_at}'
```

The fire-time `input` is merged over the trigger's static `input`, which is why
the period can be supplied per firing while the figures stay on the trigger. See
[Triggers — Schedules and Misfire Coalescing](/docs/modules/triggers#schedules-and-misfire-coalescing).

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const staticInput = {
  ledger: { cash: 128450.25, ar: 64200.0, ap: 31775.5 },
  statements: {
    bank: 128450.25,
    ar_subledger: 64200.0,
    ap_subledger: 31775.5,
  },
  tolerance: 1,
};

const { data: manualTrigger } = await adminSoat.triggers.createTrigger({
  body: {
    project_id: PROJECT_ID,
    name: 'run-close-now',
    type: 'manual',
    target_type: 'orchestration',
    target_id: CLOSE_ORCH_ID,
    input: staticInput,
  },
});

const { data: firing } = await adminSoat.triggers.fireTrigger({
  path: { trigger_id: manualTrigger.id },
  body: { input: { period: '2026-09' } },
});
console.log(firing.status, firing.result);

const { data: monthlyTrigger } = await adminSoat.triggers.createTrigger({
  body: {
    project_id: PROJECT_ID,
    name: 'month-end-close',
    type: 'schedule',
    target_type: 'orchestration',
    target_id: CLOSE_ORCH_ID,
    cron: '0 2 1 * *',
    input: staticInput,
  },
});
console.log(monthlyTrigger.next_fire_at);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MANUAL_TRIGGER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"run-close-now","type":"manual","target_type":"orchestration","target_id":"'"$CLOSE_ORCH_ID"'","input":{"ledger":{"cash":128450.25,"ar":64200.00,"ap":31775.50},"statements":{"bank":128450.25,"ar_subledger":64200.00,"ap_subledger":31775.50},"tolerance":1}}' \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers/$MANUAL_TRIGGER_ID/fire" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"period":"2026-09"}}' | jq '{status, result}'

MONTHLY_TRIGGER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"month-end-close","type":"schedule","target_type":"orchestration","target_id":"'"$CLOSE_ORCH_ID"'","cron":"0 2 1 * *","input":{"ledger":{"cash":128450.25,"ar":64200.00,"ap":31775.50},"statements":{"bank":128450.25,"ar_subledger":64200.00,"ap_subledger":31775.50},"tolerance":1}}' \
  | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/triggers/$MONTHLY_TRIGGER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{name, cron, next_fire_at}'
```

</TabItem>
</Tabs>

---

## Step 8 — Define the close period as a workflow

The reconciliation pass ends. The **period** does not — it can sit in review for
days and be sent back. That is a [workflow](/docs/modules/workflows#examples):
named states, and named transitions between them.

Two transitions carry the governance:

- `request_rework` moves `controller_review` → `reconciling`, i.e. **backward**.
  A DAG cannot express this at all; it is the reason the period is a workflow and
  not another orchestration.
- `close_period` carries both gates. Its `guard` is JSON Logic over the task —
  the period cannot close unless `payload.reconciled` is `true` — and
  `requires_approval: true` parks a human decision instead of moving the task.
  The deterministic check runs first, and the human is only asked about
  something that already passed it.

`controller_review` is a `human` state, so it never dispatches automation; it
parks until someone fires a transition. Its `stalled_after` emits a
`tasks.stalled` event if the period sits there longer than two days — see
[Stall detection](/docs/modules/workflows#stall-detection).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CLOSE_STATES='[
  { "name": "open", "initial": true },
  { "name": "reconciling" },
  { "name": "controller_review", "kind": "human", "stalled_after": 172800 },
  { "name": "closed", "terminal": true }
]'

CLOSE_TRANSITIONS='[
  { "name": "start_reconciliation", "from": ["open"], "to": "reconciling" },
  { "name": "submit_for_review", "from": ["reconciling"], "to": "controller_review" },
  { "name": "request_rework", "from": ["controller_review"], "to": "reconciling" },
  { "name": "close_period", "from": ["controller_review"], "to": "closed",
    "guard": { "==": [ { "var": "task.payload.reconciled" }, true ] },
    "requires_approval": true }
]'

WORKFLOW_ID=$(soat create-workflow \
  --project-id "$PROJECT_ID" \
  --name "Close Period" \
  --description "The life of one accounting period" \
  --states "$CLOSE_STATES" \
  --transitions "$CLOSE_TRANSITIONS" | jq -r '.id')
echo "WORKFLOW_ID: $WORKFLOW_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: workflow } = await adminSoat.workflows.createWorkflow({
  body: {
    project_id: PROJECT_ID,
    name: 'Close Period',
    description: 'The life of one accounting period',
    states: [
      { name: 'open', initial: true },
      { name: 'reconciling' },
      { name: 'controller_review', kind: 'human', stalled_after: 172800 },
      { name: 'closed', terminal: true },
    ],
    transitions: [
      { name: 'start_reconciliation', from: ['open'], to: 'reconciling' },
      {
        name: 'submit_for_review',
        from: ['reconciling'],
        to: 'controller_review',
      },
      { name: 'request_rework', from: ['controller_review'], to: 'reconciling' },
      {
        name: 'close_period',
        from: ['controller_review'],
        to: 'closed',
        guard: { '==': [{ var: 'task.payload.reconciled' }, true] },
        requires_approval: true,
      },
    ],
  },
});
const WORKFLOW_ID = workflow.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WORKFLOW_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/workflows" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Close Period","description":"The life of one accounting period","states":'"$CLOSE_STATES"',"transitions":'"$CLOSE_TRANSITIONS"'}' \
  | jq -r '.id')
echo "WORKFLOW_ID: $WORKFLOW_ID"
```

</TabItem>
</Tabs>

---

## Step 9 — Open the period and record what the run found

Create a [task](/docs/modules/workflows#task) — one card, one period — and move
it into `reconciling`. Then write the variance the exception run produced into the
card's `payload` and submit it for review. The `payload` is caller-owned, so this
is where the pipeline's finding becomes the period's state.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TASK_ID=$(soat create-task \
  --project-id "$PROJECT_ID" \
  --workflow-id "$WORKFLOW_ID" \
  --title "Close 2026-08" \
  --payload '{"period":"2026-08","reconciled":false}' | jq -r '.id')
echo "TASK_ID: $TASK_ID"

soat transition-task --task-id "$TASK_ID" --transition start_reconciliation | jq '{state}'

# Carry the total from the exception run into the card, then hand it to the controller.
soat update-task --task-id "$TASK_ID" \
  --payload '{"total_variance": '"$EXCEPTION_VARIANCE"', "reconciled": false}' | jq '{payload}'

soat transition-task --task-id "$TASK_ID" --transition submit_for_review | jq '{state, status}'
```

Expected output from the last command:

```json
{
  "state": "controller_review",
  "status": "open"
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: task } = await adminSoat.tasks.createTask({
  body: {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    title: 'Close 2026-08',
    payload: { period: '2026-08', reconciled: false },
  },
});
const TASK_ID = task.id;

await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'start_reconciliation' },
});

await adminSoat.tasks.updateTask({
  path: { task_id: TASK_ID },
  body: {
    payload: {
      total_variance: exceptionRun.state.total_variance,
      reconciled: false,
    },
  },
});

const { data: submitted } = await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'submit_for_review' },
});
console.log(submitted.state); // controller_review
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TASK_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","workflow_id":"'"$WORKFLOW_ID"'","title":"Close 2026-08","payload":{"period":"2026-08","reconciled":false}}' \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition":"start_reconciliation"}' | jq '{state}'

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"total_variance":'"$EXCEPTION_VARIANCE"',"reconciled":false}}' | jq '{payload}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition":"submit_for_review"}' | jq '{state, status}'
```

</TabItem>
</Tabs>

---

## Step 10 — The guard refuses, and the controller sends it back

The books do not balance, so `payload.reconciled` is `false` and the
`close_period` guard fails. The transition is refused before any human is asked —
the deterministic check is the outer gate, not the inner one.

The controller then fires `request_rework`, which moves the period **backward**
into `reconciling`. The team finds the missing deposit, the corrected pass ties
out, and the card goes forward again with `reconciled: true`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# The guard rejects this: payload.reconciled is still false.
# → expect-fail
soat transition-task --task-id "$TASK_ID" --transition close_period

# Backward move — the thing a DAG cannot express.
soat transition-task --task-id "$TASK_ID" --transition request_rework | jq '{state}'

# The corrected pass ties out; record it and hand the card back to the controller.
soat update-task --task-id "$TASK_ID" \
  --payload '{"total_variance": 0, "reconciled": true}' | jq '{payload}'

soat transition-task --task-id "$TASK_ID" --transition submit_for_review | jq '{state}'
```

After `request_rework` the state is `reconciling`; after `submit_for_review` it is
`controller_review` again. See
[Workflows — Guards](/docs/modules/workflows) for how a guard is evaluated
against `{task, transition, principal}`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// The guard rejects this while payload.reconciled is false.
try {
  await adminSoat.tasks.transitionTask({
    path: { task_id: TASK_ID },
    body: { transition: 'close_period' },
  });
} catch (error) {
  console.log('Refused by the guard:', error);
}

await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'request_rework' },
});

await adminSoat.tasks.updateTask({
  path: { task_id: TASK_ID },
  body: { payload: { total_variance: 0, reconciled: true } },
});

const { data: resubmitted } = await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'submit_for_review' },
});
console.log(resubmitted.state); // controller_review
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Refused by the guard while payload.reconciled is false.
curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition":"close_period"}' | jq '{error}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition":"request_rework"}' | jq '{state}'

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"total_variance":0,"reconciled":true}}' | jq '{payload}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition":"submit_for_review"}' | jq '{state}'
```

</TabItem>
</Tabs>

---

## Step 11 — Sign off: the guard passes, the human decides

Now `payload.reconciled` is `true`, so the guard passes — and
`requires_approval: true` takes effect. Firing `close_period` does **not** move
the card. It parks a pending item in the [Approvals](/docs/modules/approvals#examples)
queue and the task exposes `pending_transition` until someone resolves it. See
[Approval-gated transitions](/docs/modules/workflows#approval-gated-transitions)
for how the guard is re-evaluated at resolution time.

This is the same queue, the same endpoints, and the same audit trail that an
orchestration [`approval` node](/docs/tutorials/approval-gate) uses. Each item
carries an `origin`, so a reviewer works one queue regardless of which layer
raised the request.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Guard passes, so this parks an approval instead of closing the period.
soat transition-task --task-id "$TASK_ID" --transition close_period \
  | jq '{state, pending_transition}'

CLOSE_APPROVAL_ID=$(soat list-approvals --project-id "$PROJECT_ID" --status pending \
  | jq -r '.data[0].id')
echo "CLOSE_APPROVAL_ID: $CLOSE_APPROVAL_ID"

soat approve-approval --approval-id "$CLOSE_APPROVAL_ID" | jq '{status, resolved_by}'

soat get-task --task-id "$TASK_ID" | jq '{state, status}'
```

Expected output from the last command — entering a `terminal` state closes the
task:

```json
{
  "state": "closed",
  "status": "closed"
}
```

To reject instead, `soat reject-approval --approval-id "$CLOSE_APPROVAL_ID" --reason "Bank confirmation missing."` clears the gate and leaves the period in `controller_review`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: parked } = await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'close_period' },
});
console.log('Parked on:', parked.pending_transition);

const { data: pending } = await adminSoat.approvals.listApprovals({
  query: { project_id: PROJECT_ID, status: 'pending' },
});
const CLOSE_APPROVAL_ID = pending.data[0].id;

await adminSoat.approvals.approveApproval({
  path: { approval_id: CLOSE_APPROVAL_ID },
  body: {},
});

const { data: closed } = await adminSoat.tasks.getTask({
  path: { task_id: TASK_ID },
});
console.log(closed.state, closed.status); // closed closed
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition":"close_period"}' | jq '{state, pending_transition}'

CLOSE_APPROVAL_ID=$(curl -s "$SOAT_BASE_URL/api/v1/approvals?project_id=$PROJECT_ID&status=pending" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data[0].id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/approvals/$CLOSE_APPROVAL_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '{status, resolved_by}'

curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{state, status}'
```

</TabItem>
</Tabs>

---

## Step 12 — Read the audit trail

The period's history is a first-class record: every transition, who fired it, and
when. The rework loop is visible, and the closing move is attributed to the
`approval` principal rather than to whoever typed the command — which is exactly
what an auditor asks for.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-task-history --task-id "$TASK_ID" \
  | jq '[.[] | {transition, from_state, to_state, principal_kind}]'
```

You should see `start_reconciliation`, `submit_for_review`, `request_rework`,
`submit_for_review` again, and `close_period` — the backward move preserved in
the record, not overwritten. Project-wide activity is available through
[Activity](/docs/modules/activity) and the [Audit Log](/docs/modules/audit-log).

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: history } = await adminSoat.tasks.getTaskHistory({
  path: { task_id: TASK_ID },
});
console.log(
  history.map((h) => [
    h.transition,
    h.from_state,
    h.to_state,
    h.principal_kind,
  ])
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/history" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.[] | {transition, from_state, to_state, principal_kind}]'
```

</TabItem>
</Tabs>

---

## How It Works

- **The model never decides control flow.** Every branch is JSON Logic over
  numbers, so the same books always produce the same route. The agent writes one
  memo on one branch, declares no `output_schema`, and nothing downstream parses
  it. A slower or weaker model changes the prose and nothing else.
- **A pipeline that ends, and an entity that lives.** The reconciliation pass is
  an [orchestration](/docs/modules/orchestrations) because it starts, fans out,
  converges, and terminates. The period is a
  [workflow](/docs/modules/workflows) because it persists across days and moves
  backward. Trying to model the second as a DAG is what forces people into glue
  code; `request_rework` is the transition that makes the distinction concrete.
- **Two gates, deliberately ordered.** The `guard` is deterministic and runs
  first; `requires_approval` asks a human second. A person is never paged about
  something a subtraction could have rejected — and the human decision is
  recorded rather than implied.
- **Joins are explicit.** `activation_group` with `activation_condition: "all"`
  is what makes `total_variance` wait for all three reconciliations. Without it,
  it would run as soon as the first one finished and sum whatever had landed.
- **Input and state are separate namespaces.** `{"var": "input.tolerance"}` reads
  run input; a bare `{"var": "total_variance"}` reads a state key an upstream node
  wrote. A flat reference is never satisfied from run input, and
  `validate-orchestration` catches the mistake before a run does.
- **One approvals queue, several producers.** The item here came from a workflow
  transition; in [Approval Gates](/docs/tutorials/approval-gate) an equivalent
  item comes from an orchestration node. Consumers read `origin` instead of
  branching on the producer.

## Next Steps

- Deploy this whole stack declaratively — agents, orchestration, and workflow in one document — with [Formations](/docs/tutorials/formations) and [Create an Agent Squad](/docs/tutorials/create-an-agent-squad).
- Automate the handoff between the layers: a state's `on_enter` can dispatch the reconciliation orchestration when the period enters `reconciling`. See [Workflows & Tasks](/docs/modules/workflows).
- Add `delay`, `poll`, and `loop` steps to the pass — for example, waiting on a bank feed — with [Orchestration Control Flow](/docs/tutorials/orchestration-control-flow).
- Gate a real posting call behind a tripwire with [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- Route the `tasks.stalled` event to a channel with [Webhooks](/docs/modules/webhooks) so a period that sits in review too long pages someone.
