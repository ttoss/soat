---
description: 'Classify a dangerous tool call with a guardrail — execute below a threshold, require human sign-off above it, and hard-stop on a failing guard.'
sidebar_position: 20
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Gate a Dangerous Tool with Guardrails

A [guardrail](/docs/modules/guardrails) answers a question IAM cannot: not _"may this caller reach this endpoint?"_ but _"may this **specific action, with these arguments** run on its own — or must a human sign off?"_. It classifies every gated tool call into an action class — **A** (always execute), **B** (execute only if a guard passes), **C** (human sign-off), **D** (forbidden) — using deterministic JSON Logic expressions with no LLM anywhere in the evaluation path.

You will build one guardrail over a budget-update tool and watch all three of its outcomes:

1. Create a project and the tool the guardrail gates.
2. Write a guardrail: class **B** below a threshold, class **C** at or above it, with a guard on the amount.
3. **Dry-run** all three decisions before attaching anything.
4. Attach the guardrail to the tool and drive it from an [orchestration](/docs/modules/orchestrations) tool node.
5. See a passing class **B** execute autonomously, a class **C** park the run for sign-off, and a failing guard **tripwire** into a routable hard stop.
6. Read the governance trail the platform wrote — [approvals](/docs/modules/approvals), [exceptions](/docs/modules/exceptions), and the [audit log](/docs/modules/audit-log).
7. Raise the floor for the whole project with a second guardrail, and see stricter-wins composition tighten a call that used to be autonomous.

Everything here is deterministic — **no AI provider is required**. The gate is driven from an orchestration `tool` node, which is evaluated exactly like an agent tool call but with no model in the loop.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, tools, and runs first.
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

## Step 2 — Create a project

Every resource lives inside a [project](/docs/modules/projects#examples). The project is also the broadest guardrail attach scope — you will use it in Step 12.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Guardrails Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Guardrails Demo' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Guardrails Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the tool the guardrail gates

The gate sits at the tool-execution boundary, so the guardrail needs a [Tool](/docs/modules/tools#examples) to govern. Create a read-only [SOAT tool](/docs/modules/tools) named `update-budget` so the tutorial needs no external services — in a real system this would be the tool that actually moves money.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
BUDGET_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "update-budget" \
  --type "soat" \
  --description "Stand-in for the sensitive action the guardrail gates" \
  --actions '["get-project"]' \
  --preset-parameters '{"project_id": "'"$PROJECT_ID"'"}' | jq -r '.id')
echo "BUDGET_TOOL_ID: $BUDGET_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: budgetTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'update-budget',
    type: 'soat',
    description: 'Stand-in for the sensitive action the guardrail gates',
    actions: ['get-project'],
    preset_parameters: { projectId: PROJECT_ID },
  },
});
const BUDGET_TOOL_ID = budgetTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
BUDGET_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"update-budget\",\"type\":\"soat\",\"description\":\"Stand-in for the sensitive action the guardrail gates\",\"actions\":[\"get-project\"],\"preset_parameters\":{\"projectId\":\"$PROJECT_ID\"}}" \
  | jq -r '.id')
echo "BUDGET_TOOL_ID: $BUDGET_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Write the guardrail

A [guardrail document](/docs/modules/guardrails#classification) has three parts:

- **`class`** — a literal (`A`/`B`/`C`/`D`) or a single JSON Logic expression returning one. Here: **B** below 500, **C** at or above.
- **`guard`** — a single JSON Logic expression that must be truthy for a class-**B** call to execute autonomously. Here: the amount must be under 200.
- **`default_class`** — applied when the `class` expression returns anything invalid. It defaults to **C**, so anything nobody classified needs a human. That fail-closed default is the whole point: a misconfigured document never grants autonomy.

Between them, the three amounts `150`, `900`, and `450` exercise every outcome the guardrail can produce.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
GUARDRAIL_ID=$(soat create-guardrail \
  --project-id "$PROJECT_ID" \
  --name "Budget Update Guardrail" \
  --description "Autonomous under 200, gated under 500, sign-off above" \
  --document '{
"default_class": "C",
"class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
"guard": { "<": [{ "var": "args.amount" }, 200] }
}' | jq -r '.id')
echo "GUARDRAIL_ID: $GUARDRAIL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: guardrail } = await adminSoat.guardrails.createGuardrail({
  body: {
    project_id: PROJECT_ID,
    name: 'Budget Update Guardrail',
    description: 'Autonomous under 200, gated under 500, sign-off above',
    document: {
      default_class: 'C',
      class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
      guard: { '<': [{ var: 'args.amount' }, 200] },
    },
  },
});
const GUARDRAIL_ID = guardrail.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
GUARDRAIL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/guardrails" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Budget Update Guardrail\",\"description\":\"Autonomous under 200, gated under 500, sign-off above\",\"document\":{\"default_class\":\"C\",\"class\":{\"if\":[{\"<\":[{\"var\":\"args.amount\"},500]},\"B\",\"C\"]},\"guard\":{\"<\":[{\"var\":\"args.amount\"},200]}}}" \
  | jq -r '.id')
echo "GUARDRAIL_ID: $GUARDRAIL_ID"
```

</TabItem>
</Tabs>

The document is validated on write: every `var` must resolve to the `args.*`, `context.*`, or `soat.*` [namespaces](/docs/modules/guardrails#guards-and-guardrail-context), and an out-of-catalog `soat.*` key is rejected with `400` rather than silently reading `null` at runtime.

---

## Step 5 — Dry-run every decision before attaching

Attaching a `default_class: C` guardrail to a busy tool without rehearsing it floods the approvals queue. [Dry-run evaluation](/docs/modules/guardrails#dry-run-evaluation) runs the real pipeline — the `class` expression, the guard, live `soat.*` resolution — against arguments you supply and returns the exact evaluation record a real call would produce. Nothing executes, no approval is filed, no activity is written.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat evaluate-guardrail --guardrail-id "$GUARDRAIL_ID" --tool-id "$BUDGET_TOOL_ID" \
  --args '{"amount": 150}' | jq '{class, decision, guard_result, context_snapshot}'
```

Expected output — under both thresholds, so it runs on its own:

```json
{
  "class": "B",
  "decision": "execute",
  "guard_result": true,
  "context_snapshot": {
    "args.amount": 150
  }
}
```

Now the other two amounts:

```bash
soat evaluate-guardrail --guardrail-id "$GUARDRAIL_ID" --tool-id "$BUDGET_TOOL_ID" \
  --args '{"amount": 900}' | jq '{class, decision, guard_result}'
```

```bash
soat evaluate-guardrail --guardrail-id "$GUARDRAIL_ID" --tool-id "$BUDGET_TOOL_ID" \
  --args '{"amount": 450}' | jq '{class, decision, guard_result}'
```

`900` classifies **C** (`decision: "route_to_approval"`, `guard_result: null` — the guard is not consulted for a class-C call). `450` classifies **B** but fails the `< 200` guard, so `decision: "tripwire"`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
for (const amount of [150, 900, 450]) {
  const { data: evaluation } = await adminSoat.guardrails.evaluateGuardrail({
    path: { guardrail_id: GUARDRAIL_ID },
    body: { args: { amount }, tool_id: BUDGET_TOOL_ID },
  });
  console.log(amount, evaluation.class, evaluation.decision, evaluation.guard_result);
}
// 150 B execute      true
// 900 C route_to_approval null
// 450 B tripwire     false
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
for amount in 150 900 450; do
  curl -s -X POST "$SOAT_BASE_URL/api/v1/guardrails/$GUARDRAIL_ID/evaluate" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"args\":{\"amount\":$amount},\"tool_id\":\"$BUDGET_TOOL_ID\"}" \
    | jq '{class, decision, guard_result}'
done
```

</TabItem>
</Tabs>

:::warning
JSON Logic coerces an **absent** `var` to a zero-ish value, so `{ "<": [{ "var": "args.amount" }, 500] }` is `true` when `amount` is missing entirely — a call with no `amount` takes the permissive branch. When a missing argument must not reach it, test presence explicitly: `{ "and": [{ "var": "args.amount" }, { "<": [{ "var": "args.amount" }, 500] }] }`. See [Missing keys and comparisons](/docs/modules/guardrails#guards-and-guardrail-context).
:::

---

## Step 6 — Attach the guardrail to the tool

A guardrail governs nothing until it is [attached](/docs/modules/guardrails#attachment). Attaching at the **tool** scope means this tool carries its own gate wherever it is used — binding it to a new agent can never silently escape classification. `guardrail_ids` is a list, so several guardrails can compose on one tool.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-tool --tool-id "$BUDGET_TOOL_ID" \
  --guardrail-ids "$GUARDRAIL_ID" | jq '{id, name, guardrail_ids}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.tools.updateTool({
  path: { tool_id: BUDGET_TOOL_ID },
  body: { guardrail_ids: [GUARDRAIL_ID] },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/tools/$BUDGET_TOOL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"guardrail_ids\":[\"$GUARDRAIL_ID\"]}" | jq '{id, name, guardrail_ids}'
```

</TabItem>
</Tabs>

Attach is cheap, detach is gated: adding an id needs only `tools:UpdateTool`, because it can only tighten the outcome. Removing one additionally requires `guardrails:DetachGuardrail` — see [Step 13](#step-13--edits-are-versioned-detach-is-gated).

---

## Step 7 — Drive the tool from an orchestration

An [orchestration](/docs/modules/orchestrations#node-types) `tool` node is gated at dispatch exactly like an agent tool call, minus the model — which makes it the deterministic way to watch a guardrail work. With no agent in scope it composes the **project + tool** scopes only.

The `apply` node feeds the run's `amount` into the tool call, and that value becomes the guardrail's `args.amount`. Three edges cover the outcomes: the unlabeled edge is the success path, and the `blocked` / `tripwire` edges catch a guardrail refusal — a refusal is a **routable outcome**, not a run failure, so an unlabeled success edge does not auto-follow it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_NODES='[
  {"id":"apply","type":"tool","tool_id":"'"$BUDGET_TOOL_ID"'","operation_id":"get-project","input_mapping":{"amount":{"var":"input.amount"}}},
  {"id":"done","type":"transform","expression":"Budget updated.","state_mapping":{"state.outcome":{"var":"output.result"}}},
  {"id":"halted","type":"transform","expression":"Stopped by a guardrail.","state_mapping":{"state.outcome":{"var":"output.result"}}}
]'

ORCH_EDGES='[
  {"from":"apply","to":"done"},
  {"from":"apply","to":"halted","condition":"blocked"},
  {"from":"apply","to":"halted","condition":"tripwire"}
]'

ORCHESTRATION_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Budget Update Pipeline" \
  --description "Applies a budget change through the gated tool" \
  --nodes "$ORCH_NODES" \
  --edges "$ORCH_EDGES" | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestration } =
  await adminSoat.orchestrations.createOrchestration({
    body: {
      project_id: PROJECT_ID,
      name: 'Budget Update Pipeline',
      description: 'Applies a budget change through the gated tool',
      nodes: [
        {
          id: 'apply',
          type: 'tool',
          tool_id: BUDGET_TOOL_ID,
          operation_id: 'get-project',
          input_mapping: { amount: { var: 'input.amount' } },
        },
        {
          id: 'done',
          type: 'transform',
          expression: 'Budget updated.',
          state_mapping: { 'state.outcome': { var: 'output.result' } },
        },
        {
          id: 'halted',
          type: 'transform',
          expression: 'Stopped by a guardrail.',
          state_mapping: { 'state.outcome': { var: 'output.result' } },
        },
      ],
      edges: [
        { from: 'apply', to: 'done' },
        { from: 'apply', to: 'halted', condition: 'blocked' },
        { from: 'apply', to: 'halted', condition: 'tripwire' },
      ],
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Budget Update Pipeline\",\"description\":\"Applies a budget change through the gated tool\",\"nodes\":[{\"id\":\"apply\",\"type\":\"tool\",\"tool_id\":\"$BUDGET_TOOL_ID\",\"operation_id\":\"get-project\",\"input_mapping\":{\"amount\":{\"var\":\"input.amount\"}}},{\"id\":\"done\",\"type\":\"transform\",\"expression\":\"Budget updated.\",\"state_mapping\":{\"state.outcome\":{\"var\":\"output.result\"}}},{\"id\":\"halted\",\"type\":\"transform\",\"expression\":\"Stopped by a guardrail.\",\"state_mapping\":{\"state.outcome\":{\"var\":\"output.result\"}}}],\"edges\":[{\"from\":\"apply\",\"to\":\"done\"},{\"from\":\"apply\",\"to\":\"halted\",\"condition\":\"blocked\"},{\"from\":\"apply\",\"to\":\"halted\",\"condition\":\"tripwire\"}]}" \
  | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Class B with a passing guard: the call just runs

Start a [run](/docs/modules/orchestrations#examples) with `amount: 150`. The guardrail classifies **B**, the guard passes, and the tool dispatches with no human involved. This is the case that matters most in production — a guardrail's job is to stay out of the way until it shouldn't.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN1=$(soat start-orchestration-run --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"amount":150}' --wait true)
RUN1_ID=$(printf '%s\n' "$RUN1" | jq -r '.id')
printf '%s\n' "$RUN1" | jq '{status, required_action}'
soat get-orchestration-run --run-id "$RUN1_ID" | jq '{outcome: .state.outcome}'
```

Expected output:

```json
{ "status": "succeeded", "required_action": null }
{ "outcome": "Budget updated." }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run1 } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCHESTRATION_ID,
    input: { amount: 150 },
    wait: true,
  },
});
console.log(run1.status); // succeeded
console.log(run1.state.outcome); // Budget updated.
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN1=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"amount\":150},\"wait\":true}")
RUN1_ID=$(printf '%s\n' "$RUN1" | jq -r '.id')
printf '%s\n' "$RUN1" | jq '{status, required_action}'
```

</TabItem>
</Tabs>

---

## Step 9 — Class C: the run parks for sign-off

Now `amount: 900`. The guardrail classifies **C**, so the tool is **not** dispatched: the run parks as `awaiting_input` and files an [approval item](/docs/modules/approvals#data-model) carrying the frozen arguments.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN2=$(soat start-orchestration-run --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"amount":900}' --wait true)
RUN2_ID=$(printf '%s\n' "$RUN2" | jq -r '.id')
APPROVAL_ID=$(printf '%s\n' "$RUN2" | jq -r '.required_action.approval_id')
printf '%s\n' "$RUN2" | jq '{status, required_action}'
```

Expected output:

```json
{
  "status": "awaiting_input",
  "required_action": {
    "type": "approval",
    "node_id": "apply",
    "prompt": "Approval required for tool call.",
    "context": { "amount": 900 },
    "approval_id": "apr_...",
    "expires_at": "..."
  }
}
```

The item records exactly which guardrail — and which **version** of it — sent the call here:

```bash
soat get-approval --approval-id "$APPROVAL_ID" \
  | jq '{status, origin, run_id, node_id, proposed_action, policy_version}'
```

```json
{
  "status": "pending",
  "origin": "node",
  "run_id": "orch_run_...",
  "node_id": "apply",
  "proposed_action": { "tool_id": "tool_...", "arguments": { "amount": 900 } },
  "policy_version": "guard_...@1"
}
```

Approve it, and the node re-dispatches the tool with the frozen arguments:

```bash
soat approve-approval --approval-id "$APPROVAL_ID" | jq '{status, resolved_by}'
soat get-orchestration-run --run-id "$RUN2_ID" | jq '{status, outcome: .state.outcome}'
```

```json
{ "status": "succeeded", "outcome": "Budget updated." }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run2 } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCHESTRATION_ID,
    input: { amount: 900 },
    wait: true,
  },
});
console.log(run2.status); // awaiting_input
const APPROVAL_ID = run2.required_action.approval_id;

const { data: item } = await adminSoat.approvals.getApproval({
  path: { approval_id: APPROVAL_ID },
});
console.log(item.proposed_action, item.policy_version);

await adminSoat.approvals.approveApproval({
  path: { approval_id: APPROVAL_ID },
  body: {},
});

const { data: resumed } = await adminSoat.orchestrations.getOrchestrationRun({
  path: { run_id: run2.id },
});
console.log(resumed.status, resumed.state.outcome); // succeeded Budget updated.
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN2=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"amount\":900},\"wait\":true}")
RUN2_ID=$(printf '%s\n' "$RUN2" | jq -r '.id')
APPROVAL_ID=$(printf '%s\n' "$RUN2" | jq -r '.required_action.approval_id')

curl -s "$SOAT_BASE_URL/api/v1/approvals/$APPROVAL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{proposed_action, policy_version}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/approvals/$APPROVAL_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{}' | jq '{status}'

curl -s "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN2_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, outcome: .state.outcome}'
```

</TabItem>
</Tabs>

On approval the tool is re-dispatched with the frozen (or edited) arguments and the guardrail is **not** re-evaluated — the human decision is final for that call. Rejection or expiry means the tool never runs at all, and only a matching `rejected` / `expired` edge follows.

---

## Step 10 — A failing guard: the tripwire

`amount: 450` classifies **B** — but fails the `< 200` guard. By default a failing class-B guard is a [tripwire](/docs/modules/guardrails#tripwires-and-escalate): it aborts the action outright rather than quietly downgrading it. That is what stops a runaway loop with a hard, non-LLM decision.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN3=$(soat start-orchestration-run --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"amount":450}' --wait true)
RUN3_ID=$(printf '%s\n' "$RUN3" | jq -r '.id')
soat get-orchestration-run --run-id "$RUN3_ID" \
  | jq '{status, outcome: .state.outcome, refusal: .artifacts.apply}'
```

Expected output — the run **succeeds** down the `tripwire` edge; the refusal is data, not a crash:

```json
{
  "status": "succeeded",
  "outcome": "Stopped by a guardrail.",
  "refusal": {
    "status": "tripwire",
    "reason": "A guardrail tripwire fired: a class-B guard failed and the action was aborted."
  }
}
```

A tripwire also files an [exception](/docs/modules/exceptions#severity) so the abort lands in a triage queue instead of a log line:

```bash
soat list-exceptions --project-id "$PROJECT_ID" --kind guardrail_tripwire \
  | jq '.data[0] | {kind, severity, status, title, occurrence_count}'
```

```json
{
  "kind": "guardrail_tripwire",
  "severity": "warning",
  "status": "open",
  "title": "Guardrail tripwire aborted update-budget",
  "occurrence_count": 1
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run3 } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCHESTRATION_ID,
    input: { amount: 450 },
    wait: true,
  },
});

const { data: settled } = await adminSoat.orchestrations.getOrchestrationRun({
  path: { run_id: run3.id },
});
console.log(settled.state.outcome); // Stopped by a guardrail.
console.log(settled.artifacts.apply); // { status: 'tripwire', reason: '...' }

const { data: exceptions } = await adminSoat.exceptions.listExceptions({
  params: { query: { project_id: PROJECT_ID, kind: 'guardrail_tripwire' } },
});
console.log(exceptions.data[0].title);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN3=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"amount\":450},\"wait\":true}")
RUN3_ID=$(printf '%s\n' "$RUN3" | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN3_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{status, outcome: .state.outcome, refusal: .artifacts.apply}'

curl -s "$SOAT_BASE_URL/api/v1/exceptions?project_id=$PROJECT_ID&kind=guardrail_tripwire" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0] | {kind, severity, title}'
```

</TabItem>
</Tabs>

:::tip
Add `"escalate": true` to the document to soften this: a failing guard then routes to the approvals queue for a human decision instead of aborting. `escalate` is per-guardrail, and a tripwire from another applying guardrail still wins.
:::

---

## Step 11 — Read the governance trail

Every evaluation writes a `guardrail_evaluation` record. Those that **changed the call's outcome** — `route_to_approval`, `blocked`, `tripwire`, but not a plain `execute` — are also mirrored into the [audit log](/docs/modules/audit-log#system-originated-entries) as platform-originated entries, so governance decisions are queryable on the same substrate as "who deleted that secret".

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-audit-entries --project-id "$PROJECT_ID" --action "guardrails:Evaluate" \
  | jq '[.data[] | {resource_srn, class: .detail.class, decision: .detail.decision, approval_id: .detail.approval_id}]'
```

Expected output — the class-C route and the tripwire are recorded; the autonomous class-B `execute` from Step 8 is not (it is high-volume operational telemetry, kept only in the guardrail's own evaluation records):

```json
[
  {
    "resource_srn": "soat:proj_...:guardrail:guard_...",
    "class": "B",
    "decision": "tripwire",
    "approval_id": null
  },
  {
    "resource_srn": "soat:proj_...:guardrail:guard_...",
    "class": "C",
    "decision": "route_to_approval",
    "approval_id": "apr_..."
  }
]
```

Each entry's `detail` also carries the `context_snapshot` — a flat map of **only** the vars the evaluation actually referenced, frozen at their evaluation-time values. It is the only way to answer "why did this pass?" after the application's context has moved on.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: audit } = await adminSoat.auditLog.listAuditEntries({
  params: { query: { project_id: PROJECT_ID, action: 'guardrails:Evaluate' } },
});
for (const entry of audit.data) {
  console.log(entry.detail.class, entry.detail.decision, entry.detail.context_snapshot);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/audit-log?project_id=$PROJECT_ID&action=guardrails:Evaluate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {class: .detail.class, decision: .detail.decision}]'
```

</TabItem>
</Tabs>

---

## Step 12 — Raise the floor for the whole project

There is no override resource. To run a stricter posture, [attach a tighter guardrail at the project scope](/docs/modules/guardrails#running-a-tighter-posture-in-one-project) — an always-`C` document forces sign-off on every tool call in the project.

Because composition is **stricter-wins**, this can only tighten: the `amount: 150` call that executed autonomously in Step 8 now parks.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
BASELINE_ID=$(soat create-guardrail \
  --project-id "$PROJECT_ID" \
  --name "Sign-off Baseline" \
  --document '{"class": "C"}' | jq -r '.id')

soat update-project --project-id "$PROJECT_ID" \
  --guardrail-ids "$BASELINE_ID" | jq '{guardrail_ids}'

RUN4=$(soat start-orchestration-run --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"amount":150}' --wait true)
printf '%s\n' "$RUN4" | jq '{status, node_id: .required_action.node_id}'
soat get-approval --approval-id "$(printf '%s\n' "$RUN4" | jq -r '.required_action.approval_id')" \
  | jq '{policy_version}'
```

Expected output — the same input, now gated, and `policy_version` names the **baseline** as the governing guardrail:

```json
{ "status": "awaiting_input", "node_id": "apply" }
{ "policy_version": "guard_...@1" }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: baseline } = await adminSoat.guardrails.createGuardrail({
  body: {
    project_id: PROJECT_ID,
    name: 'Sign-off Baseline',
    document: { class: 'C' },
  },
});

await adminSoat.projects.updateProject({
  path: { project_id: PROJECT_ID },
  body: { guardrail_ids: [baseline.id] },
});

const { data: run4 } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCHESTRATION_ID,
    input: { amount: 150 },
    wait: true,
  },
});
console.log(run4.status); // awaiting_input — the tool-scoped guardrail said execute
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
BASELINE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/guardrails" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Sign-off Baseline\",\"document\":{\"class\":\"C\"}}" \
  | jq -r '.id')

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"guardrail_ids\":[\"$BASELINE_ID\"]}" | jq '{guardrail_ids}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"amount\":150},\"wait\":true}" \
  | jq '{status}'
```

</TabItem>
</Tabs>

Other projects — which don't carry the attachment — are untouched. A tenant can raise the floor, never lower it.

---

## Step 13 — Edits are versioned, detach is gated

Every write to a `document` increments `version` and archives the prior one, so an approval item's `policy_version` always resolves to the exact text that governed it. See [Versioning](/docs/modules/guardrails#versioning).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-guardrail --guardrail-id "$GUARDRAIL_ID" --document '{
"default_class": "C",
"class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
"guard": { "<": [{ "var": "args.amount" }, 100] }
}' | jq '{version}'

soat get-guardrail-version --guardrail-id "$GUARDRAIL_ID" --version 1 \
  | jq '{version, guard: .document.guard}'
```

Expected output — the live guardrail is now `version: 2`, and version 1's original `< 200` guard is still retrievable:

```json
{ "version": 2 }
{ "version": 1, "guard": { "<": [{ "var": "args.amount" }, 200] } }
```

Attachments reference the guardrail's **id**, not a version, so this edit takes effect immediately everywhere it is attached — [dry-run](#step-5--dry-run-every-decision-before-attaching) an edit before writing it when the guardrail is attached at scale.

Deletion refuses to do what detach permissions forbid. While the guardrail is still attached, `delete-guardrail` returns `409` listing every reference:

```bash
# → expect-fail
soat delete-guardrail --guardrail-id "$GUARDRAIL_ID"
```

```json
{
  "status": 409,
  "error": {
    "code": "GUARDRAIL_HAS_REFERENCES",
    "message": "Guardrail 'guard_...' is still attached and cannot be deleted. Detach it from every tool, agent, and project first.",
    "meta": { "references": { "tools": ["tool_..."], "agents": [], "projects": [] } }
  }
}
```

Detach first — which requires `guardrails:DetachGuardrail` on top of `tools:UpdateTool` — and the delete succeeds:

```bash
soat update-tool --tool-id "$BUDGET_TOOL_ID" --guardrail-ids '[]' | jq '{guardrail_ids}'
soat delete-guardrail --guardrail-id "$GUARDRAIL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: updated } = await adminSoat.guardrails.updateGuardrail({
  path: { guardrail_id: GUARDRAIL_ID },
  body: {
    document: {
      default_class: 'C',
      class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
      guard: { '<': [{ var: 'args.amount' }, 100] },
    },
  },
});
console.log(updated.version); // 2

const { data: v1 } = await adminSoat.guardrails.getGuardrailVersion({
  path: { guardrail_id: GUARDRAIL_ID, version: 1 },
});
console.log(v1.document.guard); // { '<': [{ var: 'args.amount' }, 200] }

// Deleting while attached fails with 409 GUARDRAIL_HAS_REFERENCES.
await adminSoat.tools.updateTool({
  path: { tool_id: BUDGET_TOOL_ID },
  body: { guardrail_ids: [] },
});
await adminSoat.guardrails.deleteGuardrail({
  path: { guardrail_id: GUARDRAIL_ID },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/guardrails/$GUARDRAIL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"document":{"default_class":"C","class":{"if":[{"<":[{"var":"args.amount"},500]},"B","C"]},"guard":{"<":[{"var":"args.amount"},100]}}}' \
  | jq '{version}'

curl -s "$SOAT_BASE_URL/api/v1/guardrails/$GUARDRAIL_ID/versions/1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{version, guard: .document.guard}'

# 409 while still attached
curl -s -X DELETE "$SOAT_BASE_URL/api/v1/guardrails/$GUARDRAIL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.error.code'

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/tools/$BUDGET_TOOL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"guardrail_ids":[]}' | jq '{guardrail_ids}'

curl -s -X DELETE "$SOAT_BASE_URL/api/v1/guardrails/$GUARDRAIL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -o /dev/null -w '%{http_code}\n'
```

</TabItem>
</Tabs>

---

## How It Works

- **A different layer than IAM.** An [IAM policy](/docs/modules/policies) decides whether a caller may invoke an endpoint, at request time. A guardrail decides whether *this call, with these arguments* may run on its own, at the tool-execution boundary — after the arguments exist and before anything touches the outside world. Guardrails deliberately do not touch policies.
- **Fail-closed at both ends.** At write time a `var` outside the three namespaces is rejected with `400`. At evaluation time an unresolvable `context.*` key, a context-tool timeout, or an invalid `class` result resolves to `default_class` (**C** by default) in `class`, and counts as a **failed guard** in `guard`. Forgetting to supply context tightens the posture; it never loosens it.
- **Stricter-wins composition.** Every guardrail that applies — project, agent, and tool scope — evaluates, and the strictest decision wins, ordered `blocked` > `tripwire` > `route_to_approval` > `execute`. Class **A** is the identity, so a guardrail that returns `"A"` simply defers to the others. Composition is order-independent and can only tighten.
- **A refusal is routable.** A class-**D** block or a tripwire on an orchestration tool node records a `{ status, reason }` artifact and branches by label rather than failing the run, so a fallback path can handle it. An unlabeled success edge never auto-follows a blocked node.
- **No LLM in the path.** `class` and `guard` are JSON Logic, evaluated by the same engine orchestration mappings use. A model can propose an action but can never influence its classification.

## Next Steps

- Feed live values into guards with `guardrail_context` and a `context_tool_id`, and cap a runaway run with `soat.usage.run_tokens` — see [Per-run spend ceilings](/docs/modules/guardrails#per-run-spend-ceilings).
- Model an explicit human decision point in the graph instead of a guardrail-driven one with the [`approval` node](/docs/tutorials/approval-gate).
- Cap aggregate spend rather than individual calls with [Cap Spend Per End User](/docs/tutorials/cap-spend-per-end-user).
- Triage what a tripwire files — see [Exceptions](/docs/modules/exceptions).
