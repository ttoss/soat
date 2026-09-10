---
description: 'Make a canary rollout wait for evidence: declare a suite alongside the agent in a formation, pin a run to the canary version, and let promotion succeed only once that run passes.'
keywords:
  - eval gated promotion
  - canary promotion gate
  - AI agent CI CD
  - automated prompt rollout
  - scheduled eval run
  - eval webhook
sidebar_position: 28
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Gate a Canary Promotion on an Eval

A **promotion gate** names an [eval](/docs/modules/evaluations) on a [canary release](/docs/tutorials/agent-versioning-and-canary-rollout); `promote-agent-release` refuses until that eval has a run that finished `completed`, `passed: true`, pinned to the canary version.

You will deploy an agent and its suite as one [formation](/docs/modules/formations), change the prompt through the template, start a gated canary release, see `PROMOTION_GATE_UNMET`, see a green run of the wrong version fail to open the gate, produce the run that does, promote, then add a nightly scheduled run and a webhook.

Assumes [Evaluate an Agent](/docs/tutorials/evaluate-an-agent).

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

See [Users](/docs/modules/users#examples) and [Projects](/docs/modules/projects).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

PROJECT_ID=$(soat create-project --name "Gated Rollout" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
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

const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Gated Rollout' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Gated Rollout"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 2 — Ship the agent and its suite in one template

Datasets, dataset items, and evals are [formation](/docs/modules/formations) resource types, so the suite lives in the agent's template. Test cases are their own resource, not a list inside the dataset (same shape as [Memories](/docs/modules/memories)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
cat > release-notes-formation.json << 'EOF'
{
  "resources": {
    "provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Local Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "agent": {
      "type": "agent",
      "properties": {
        "name": "Release Notes Writer",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "Summarize the change in one sentence."
      }
    },
    "suite": {
      "type": "dataset",
      "properties": {
        "name": "release-notes-suite",
        "description": "Cases every release must still pass"
      }
    },
    "emptyFileCase": {
      "type": "dataset_item",
      "properties": {
        "dataset_id": { "ref": "suite" },
        "input": [{ "role": "user", "content": "We fixed a crash when uploading a 0-byte file." }],
        "expected_output": "Fixed a crash when uploading an empty file."
      }
    },
    "passkeyCase": {
      "type": "dataset_item",
      "properties": {
        "dataset_id": { "ref": "suite" },
        "input": [{ "role": "user", "content": "Login now supports passkeys." }],
        "expected_output": "Added passkey support to login."
      }
    },
    "gate": {
      "type": "eval",
      "properties": {
        "name": "release-notes-gate",
        "agent_id": { "ref": "agent" },
        "dataset_id": { "ref": "suite" },
        "scorers": [
          { "type": "json_logic", "expression": { "!=": [{ "var": "output" }, ""] } }
        ],
        "pass_threshold": 1
      }
    }
  },
  "outputs": {
    "agent_id": { "ref": "agent" },
    "eval_id": { "ref": "gate" },
    "dataset_id": { "ref": "suite" }
  }
}
EOF

TEMPLATE=$(cat release-notes-formation.json)

STACK=$(soat create-formation \
  --project-id "$PROJECT_ID" \
  --name "release-notes-stack" \
  --template "$TEMPLATE")

FORMATION_ID=$(printf '%s' "$STACK" | jq -r '.id')
AGENT_ID=$(printf '%s' "$STACK" | jq -r '.outputs.agent_id')
EVAL_ID=$(printf '%s' "$STACK" | jq -r '.outputs.eval_id')

printf '%s' "$STACK" | jq '{status, outputs}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const template = {
  resources: {
    provider: {
      type: 'ai_provider',
      properties: {
        name: 'Local Ollama',
        provider: 'ollama',
        default_model: 'qwen2.5:0.5b',
      },
    },
    agent: {
      type: 'agent',
      properties: {
        name: 'Release Notes Writer',
        ai_provider_id: { ref: 'provider' },
        instructions: 'Summarize the change in one sentence.',
      },
    },
    suite: {
      type: 'dataset',
      properties: {
        name: 'release-notes-suite',
        description: 'Cases every release must still pass',
      },
    },
    emptyFileCase: {
      type: 'dataset_item',
      properties: {
        dataset_id: { ref: 'suite' },
        input: [
          {
            role: 'user',
            content: 'We fixed a crash when uploading a 0-byte file.',
          },
        ],
        expected_output: 'Fixed a crash when uploading an empty file.',
      },
    },
    passkeyCase: {
      type: 'dataset_item',
      properties: {
        dataset_id: { ref: 'suite' },
        input: [{ role: 'user', content: 'Login now supports passkeys.' }],
        expected_output: 'Added passkey support to login.',
      },
    },
    gate: {
      type: 'eval',
      properties: {
        name: 'release-notes-gate',
        agent_id: { ref: 'agent' },
        dataset_id: { ref: 'suite' },
        scorers: [
          { type: 'json_logic', expression: { '!=': [{ var: 'output' }, ''] } },
        ],
        pass_threshold: 1,
      },
    },
  },
  outputs: {
    agent_id: { ref: 'agent' },
    eval_id: { ref: 'gate' },
    dataset_id: { ref: 'suite' },
  },
};

const { data: stack } = await adminSoat.formations.createFormation({
  body: {
    project_id: project.id,
    name: 'release-notes-stack',
    template,
  },
});

const AGENT_ID = stack.outputs?.agent_id as string;
const EVAL_ID = stack.outputs?.eval_id as string;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
cat > release-notes-formation.json << 'EOF'
{
  "resources": {
    "provider": { "type": "ai_provider", "properties": { "name": "Local Ollama", "provider": "ollama", "default_model": "qwen2.5:0.5b" } },
    "agent": { "type": "agent", "properties": { "name": "Release Notes Writer", "ai_provider_id": { "ref": "provider" }, "instructions": "Summarize the change in one sentence." } },
    "suite": { "type": "dataset", "properties": { "name": "release-notes-suite", "description": "Cases every release must still pass" } },
    "emptyFileCase": { "type": "dataset_item", "properties": { "dataset_id": { "ref": "suite" }, "input": [{ "role": "user", "content": "We fixed a crash when uploading a 0-byte file." }], "expected_output": "Fixed a crash when uploading an empty file." } },
    "passkeyCase": { "type": "dataset_item", "properties": { "dataset_id": { "ref": "suite" }, "input": [{ "role": "user", "content": "Login now supports passkeys." }], "expected_output": "Added passkey support to login." } },
    "gate": { "type": "eval", "properties": { "name": "release-notes-gate", "agent_id": { "ref": "agent" }, "dataset_id": { "ref": "suite" }, "scorers": [{ "type": "json_logic", "expression": { "!=": [{ "var": "output" }, ""] } }], "pass_threshold": 1 } }
  },
  "outputs": { "agent_id": { "ref": "agent" }, "eval_id": { "ref": "gate" }, "dataset_id": { "ref": "suite" } }
}
EOF

STACK=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/formations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"release-notes-stack\",\"template\":$(cat release-notes-formation.json | jq -c .)}")

FORMATION_ID=$(printf '%s' "$STACK" | jq -r '.id')
AGENT_ID=$(printf '%s' "$STACK" | jq -r '.outputs.agent_id')
EVAL_ID=$(printf '%s' "$STACK" | jq -r '.outputs.eval_id')
```

</TabItem>
</Tabs>

The only scorer asserts the agent answered at all, so the gate mechanism, not the 0.5B model's output, is under observation. A real gate uses the scorers from [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) and a judge from [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers).

---

## Step 3 — Change the prompt through the template

A formation apply archives a version exactly as a `PUT` would ([Agents — Versioning and Staged Rollout](/docs/modules/agents#versioning-and-staged-rollout)). An out-of-band `update-agent` on a formation-managed agent is drift the next apply undoes.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CANDIDATE_TEMPLATE=$(printf '%s' "$TEMPLATE" | jq \
  '.resources.agent.properties.instructions = "Summarize the change in one sentence, in past tense, starting with a verb."')

soat update-formation --formation-id "$FORMATION_ID" --template "$CANDIDATE_TEMPLATE" | jq '{status}'

soat list-agent-versions --agent-id "$AGENT_ID" | jq '.data | map({version, instructions: .config.instructions})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const candidateTemplate = structuredClone(template);
candidateTemplate.resources.agent.properties.instructions =
  'Summarize the change in one sentence, in past tense, starting with a verb.';

await adminSoat.formations.updateFormation({
  path: { formation_id: stack.id },
  body: { template: candidateTemplate },
});

const { data: versions } = await adminSoat.agentVersions.listAgentVersions({
  path: { agent_id: AGENT_ID },
});
console.log(versions.data.map((v) => v.version)); // [2, 1]
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CANDIDATE_TEMPLATE=$(jq -c \
  '.resources.agent.properties.instructions = "Summarize the change in one sentence, in past tense, starting with a verb."' \
  release-notes-formation.json)

curl -s -X PUT "$SOAT_BASE_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"template\":$CANDIDATE_TEMPLATE}" | jq '{status}'

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/versions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({version})'
```

</TabItem>
</Tabs>

Version 2 now exists in history. No traffic serves it yet.

---

## Step 4 — Start a gated canary release

An ordinary canary release ([Agents — Staged Rollout](/docs/modules/agents#staged-rollout)), 20% of traffic on version 2, plus `--promotion-gate`: the eval that must go green before promotion.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat set-agent-release --agent-id "$AGENT_ID" \
  --stable-version 1 --canary-version 2 --canary-percent 20 \
  --promotion-gate "$EVAL_ID" | jq '{active_release}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: released } = await adminSoat.agentVersions.setAgentRelease({
  path: { agent_id: AGENT_ID },
  body: {
    stable_version: 1,
    canary_version: 2,
    canary_percent: 20,
    promotion_gate: EVAL_ID,
  },
});
console.log(released.active_release);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"stable_version\":1,\"canary_version\":2,\"canary_percent\":20,\"promotion_gate\":\"$EVAL_ID\"}" \
  | jq '{active_release}'
```

</TabItem>
</Tabs>

Expected output:

```json
{
  "active_release": {
    "stable_version": 1,
    "canary_version": 2,
    "canary_percent": 20,
    "promotion_gate": "eval_rgMz0oEpbT3oWEK9"
  }
}
```

---

## Step 5 — Promotion is refused until there is evidence

With no qualifying run, `promote` is a `409` and changes nothing ([Agents — Eval-gated promotion](/docs/modules/agents#eval-gated-promotion)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat promote-agent-release --agent-id "$AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await adminSoat.agentVersions.promoteAgentRelease({
  path: { agent_id: AGENT_ID },
});
console.log(error.error.code); // PROMOTION_GATE_UNMET (409)
console.log(error.error.meta); // { promotion_gate: EVAL_ID, agent_version: 2 }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release/promote" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{code: .error.code, meta: .error.meta}'
```

</TabItem>
</Tabs>

Expected output (the rollout keeps running):

```json
{
  "code": "PROMOTION_GATE_UNMET",
  "meta": { "promotion_gate": "eval_rgMz0oEpbT3oWEK9", "agent_version": 2 }
}
```

---

## Step 6 — A green run of the wrong version does not count

Run the eval without `agent_version`. During an active release an unpinned run uses the stable version, so this measures version 1.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STABLE_RUN=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true)
printf '%s' "$STABLE_RUN" | jq '{agent_version, status, passed}'

# → expect-fail
soat promote-agent-release --agent-id "$AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: stableRun } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: EVAL_ID },
  body: { wait: true },
});
console.log(stableRun.agent_version, stableRun.passed); // 1 true

const { error: still } = await adminSoat.agentVersions.promoteAgentRelease({
  path: { agent_id: AGENT_ID },
});
console.log(still.error.code); // PROMOTION_GATE_UNMET — the green run was version 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":true}' | jq '{agent_version, passed}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release/promote" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.error.code'
```

</TabItem>
</Tabs>

The run passes and the gate stays shut: a green run against another version is not evidence about the canary. A run resolves one version at start, stamps it on `agent_version`, and every item executes against it ([Evaluations — Version pinning](/docs/modules/evaluations#version-pinning)).

---

## Step 7 — Produce the run that opens the gate

Same eval, pinned to the canary version ([Evaluations — Version pinning](/docs/modules/evaluations#version-pinning)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CANARY_RUN=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true --agent-version 2)
printf '%s' "$CANARY_RUN" | jq '{id, agent_version, status, passed}'

soat promote-agent-release --agent-id "$AGENT_ID" | jq '{version, active_release, instructions}'

soat list-agent-versions --agent-id "$AGENT_ID" | jq '.data | map({version, eval_run_id})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: canaryRun } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: EVAL_ID },
  body: { wait: true, agent_version: 2 },
});
console.log(canaryRun.agent_version, canaryRun.passed); // 2 true

const { data: promoted } = await adminSoat.agentVersions.promoteAgentRelease({
  path: { agent_id: AGENT_ID },
});
console.log(promoted.active_release); // null — the rollout is over
console.log(promoted.instructions); // version 2's prompt
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":true,"agent_version":2}' | jq '{agent_version, passed}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release/promote" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{version, active_release}'

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/versions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({version, eval_run_id})'
```

</TabItem>
</Tabs>

Expected output (the promoted version records which run cleared it):

```json
[
  { "version": 2, "eval_run_id": "evrun_b2vkVf4zeRG23Zic" },
  { "version": 1, "eval_run_id": null }
]
```

`eval_run_id` is the audit trail, with per-item scores behind it.

:::note

`abort-agent-release` is ungated: rolling back to the stable config is always allowed. Only promotion needs evidence.

:::

---

## Step 8 — Keep feeding the gate after you stop watching

A [trigger](/docs/modules/triggers) with `target_type: "eval"` runs the suite on a cadence. Declare it in the same template and subscribe a [webhook](/docs/modules/webhooks) to the verdict. Creating an eval-target trigger requires `evaluations:RunEval` on top of `triggers:CreateTrigger`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WEBHOOK_ID=$(soat create-webhook --project-id "$PROJECT_ID" \
  --name "eval-verdicts" \
  --url "http://127.0.0.1:9/eval-verdicts" \
  --events '["eval_run.completed","eval_run.failed"]' | jq -r '.id')

NIGHTLY_TEMPLATE=$(printf '%s' "$CANDIDATE_TEMPLATE" | jq \
  '.resources.nightly = {"type":"trigger","properties":{"name":"nightly-release-notes-gate","type":"schedule","target_type":"eval","target_id":{"ref":"gate"},"cron":"0 3 * * *"}} | .outputs.trigger_id = {"ref":"nightly"}')

TRIGGER_ID=$(soat update-formation --formation-id "$FORMATION_ID" \
  --template "$NIGHTLY_TEMPLATE" | jq -r '.outputs.trigger_id')

echo "TRIGGER_ID: $TRIGGER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: webhook } = await adminSoat.webhooks.createWebhook({
  body: {
    project_id: project.id,
    name: 'eval-verdicts',
    url: 'https://example.com/eval-verdicts',
    events: ['eval_run.completed', 'eval_run.failed'],
  },
});

const nightlyTemplate = structuredClone(candidateTemplate);
nightlyTemplate.resources.nightly = {
  type: 'trigger',
  properties: {
    name: 'nightly-release-notes-gate',
    type: 'schedule',
    target_type: 'eval',
    target_id: { ref: 'gate' },
    cron: '0 3 * * *',
  },
};
nightlyTemplate.outputs.trigger_id = { ref: 'nightly' };

const { data: withNightly } = await adminSoat.formations.updateFormation({
  path: { formation_id: stack.id },
  body: { template: nightlyTemplate },
});
const TRIGGER_ID = withNightly.outputs?.trigger_id as string;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WEBHOOK_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"eval-verdicts\",\"url\":\"https://example.com/eval-verdicts\",\"events\":[\"eval_run.completed\",\"eval_run.failed\"]}" | jq -r '.id')

NIGHTLY_TEMPLATE=$(printf '%s' "$CANDIDATE_TEMPLATE" | jq -c \
  '.resources.nightly = {"type":"trigger","properties":{"name":"nightly-release-notes-gate","type":"schedule","target_type":"eval","target_id":{"ref":"gate"},"cron":"0 3 * * *"}} | .outputs.trigger_id = {"ref":"nightly"}')

TRIGGER_ID=$(curl -s -X PUT "$SOAT_BASE_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"template\":$NIGHTLY_TEMPLATE}" | jq -r '.outputs.trigger_id')
```

</TabItem>
</Tabs>

Fire it now. A firing always starts a queued run ([sync vs async](/docs/advanced/sync-and-async)); `result.result_id` is the `evrun_…` to poll.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FIRING=$(soat fire-trigger --trigger-id "$TRIGGER_ID")
printf '%s' "$FIRING" | jq '{status, result}'

NIGHTLY_RUN_ID=$(printf '%s' "$FIRING" | jq -r '.result.result_id')

# → retry 180
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$NIGHTLY_RUN_ID" | jq -e '.status == "completed"'

soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$NIGHTLY_RUN_ID" \
  | jq '{status, passed, agent_version, trigger_id}'

# → retry 30
soat list-webhook-deliveries --webhook-id "$WEBHOOK_ID" | jq -e '.data[0].event_type == "eval_run.completed"'

soat list-webhook-deliveries --webhook-id "$WEBHOOK_ID" | jq '.data[0].payload.data'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: firing } = await adminSoat.triggers.fireTrigger({
  path: { trigger_id: TRIGGER_ID },
});
console.log(firing.result); // { target_type: 'eval', status: 'queued', result_id: 'evrun_…' }

const { data: deliveries } = await adminSoat.webhooks.listWebhookDeliveries({
  query: { webhook_id: webhook.id },
});
console.log(deliveries.data[0]?.event_type); // 'eval_run.completed'
console.log(deliveries.data[0]?.payload.data); // { eval_id, eval_run_id, passed, aggregate_scores }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FIRING=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers/$TRIGGER_ID/fire" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
NIGHTLY_RUN_ID=$(printf '%s' "$FIRING" | jq -r '.result.result_id')

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$NIGHTLY_RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, passed, trigger_id}'

curl -s "$SOAT_BASE_URL/api/v1/webhooks/deliveries?webhook_id=$WEBHOOK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0] | {event_type, payload: .payload.data}'
```

</TabItem>
</Tabs>

The run records its origin in `trigger_id`, kept even if the trigger is deleted. The delivered payload carries the verdict inline:

```json
{
  "eval_id": "eval_rgMz0oEpbT3oWEK9",
  "eval_run_id": "evrun_g5i4CdIFvcOvRZR8",
  "passed": true,
  "aggregate_scores": {
    "scorers": { "json_logic": { "mean": 1, "pass_rate": 1 } },
    "pass_rate": 1,
    "scored_item_count": 2
  }
}
```

Exactly one event fires per terminal run.

:::note[The URL above is unroutable]

`http://127.0.0.1:9/…` cannot accept a POST, so delivery fails and retries, but the delivery record still carries the event type and full payload. Point it at a real endpoint and verify the signature; see [Webhooks](/docs/modules/webhooks).

:::

The trigger's `input` may also carry `agent_version` and `baseline_run_id`, passed to every run it starts and validated at fire time: a schedule naming a version that no longer exists fails the firing, with the reason on the firing record.

---

## Next steps

- [Agent Versioning and Canary Rollout](/docs/tutorials/agent-versioning-and-canary-rollout) — rollout mechanics.
- [Formations](/docs/tutorials/formations) — declarative stacks.
- [Evaluations](/docs/modules/evaluations) — module reference.
