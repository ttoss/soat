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

[Canary rollouts](/docs/tutorials/agent-versioning-and-canary-rollout) answer "how do I try a new prompt on 10% of traffic?". They do not answer the question that follows: **who decides it is good enough to promote?** Left to a human eyeballing a few conversations, the answer is "whoever is impatient".

A **promotion gate** makes the decision evidential. A release names an [eval](/docs/modules/evaluations), and `promote-agent-release` refuses until that eval has a run which finished `completed`, with `passed: true`, **pinned to the canary version**. This is the ratchet: the system can only move in the direction the measurements allow.

You will:

1. Deploy an agent **and its test suite together** as a [formation](/docs/modules/formations) — the suite ships with the thing it verifies.
2. Change the prompt through the same template, archiving a canary candidate.
3. Start a canary release that names the eval as its `promotion_gate`.
4. Watch promotion be refused with `PROMOTION_GATE_UNMET`.
5. Watch a **green run of the wrong version** fail to open the gate — the reason pinning exists.
6. Produce the run that does open it, and promote.
7. Add a nightly scheduled run and a webhook, so the gate keeps being fed after you stop watching.

This tutorial assumes you have been through [Evaluate an Agent](/docs/tutorials/evaluate-an-agent).

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

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for authentication details, and [Projects](/docs/modules/projects) for the container everything below lives in.

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

Datasets, their items, and evals are all [formation](/docs/modules/formations) resource types, so the suite that verifies an agent lives in the same template as the agent. A checkout that has the agent always has the cases it must still pass.

Note that test cases are their own resource rather than a list inside the dataset — the same shape as [memory entries](/docs/modules/memories). An item curated by hand through the API is therefore never collateral of a formation apply, and each declared case has its own physical id.

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

The gate's only scorer asserts the agent answered at all. That is deliberately weak for a tutorial — it keeps the gate's *mechanism* the thing under observation rather than what a 0.5B-parameter model happens to write. A real gate uses the scorers from [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) and a judge from [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers).

---

## Step 3 — Change the prompt through the template

Version snapshots are written by the shared business-logic layer, not by the REST handlers, so a formation apply archives a version exactly as a `PUT` would — see [Agents — Versioning and Staged Rollout](/docs/modules/agents#versioning-and-staged-rollout). Editing through the template keeps the formation the source of truth — an out-of-band `update-agent` on a formation-managed agent is drift the next apply will undo.

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

`--promotion-gate` is the only new part of an otherwise ordinary canary release ([Agents — Staged Rollout](/docs/modules/agents#staged-rollout)): 20% of traffic on version 2, and the eval that must go green before version 2 can become everyone's.

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

With no qualifying run on record, `promote` is a `409` and changes nothing. See [Agents — Eval-gated promotion](/docs/modules/agents#eval-gated-promotion).

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
console.log(error.code); // PROMOTION_GATE_UNMET (409)
console.log(error.meta); // { promotion_gate: EVAL_ID, agent_version: 2 }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release/promote" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{code: .error.code, meta: .error.meta}'
```

</TabItem>
</Tabs>

Expected output — a `409`, with the rollout left running untouched:

```json
{
  "code": "PROMOTION_GATE_UNMET",
  "meta": { "promotion_gate": "eval_rgMz0oEpbT3oWEK9", "agent_version": 2 }
}
```

---

## Step 6 — A green run of the wrong version does not count

Run the eval **without** `agent_version`. During an active release an unpinned run uses the active release's *stable* version — so this measures version 1, the config you are trying to replace.

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
console.log(still.code); // PROMOTION_GATE_UNMET — the green run was version 1
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

A passing run, and the gate stays shut. This is the heart of the feature: **a green run against another version is not evidence about the canary.**

Pinning is not a convenience either. Release assignment keys on the [session](/docs/modules/sessions)'s [actor](/docs/modules/actors), and an eval generation has no session — so an *unpinned* run under a release that had no stable version to fall back on would bucket each item independently and blend two configs into one score. A run resolves exactly one version at start, stamps it on `agent_version`, and every item executes against it.

---

## Step 7 — Produce the run that opens the gate

Same eval, same scorers — this time pinned to the canary version, which is what [Evaluations — Version pinning](/docs/modules/evaluations#version-pinning) exists for.

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

Expected output — the promoted version records **which run cleared it**:

```json
[
  { "version": 2, "eval_run_id": "evrun_b2vkVf4zeRG23Zic" },
  { "version": 1, "eval_run_id": null }
]
```

That field is the audit trail a gated rollout is worth having: months later, "why was version 2 promoted?" has an answer with per-item scores behind it.

:::note[The gate cannot be argued with, only satisfied]

`abort-agent-release` is ungated — rolling *back* to the stable config is always allowed. Only promotion needs evidence, which is the asymmetry you want under pressure.

:::

---

## Step 8 — Keep feeding the gate after you stop watching

A [trigger](/docs/modules/triggers) with `target_type: "eval"` runs the suite on a cadence — the nightly regression nobody has to remember to start. Declare it in the same template, and subscribe a [webhook](/docs/modules/webhooks) to the verdict.

Creating an eval-target trigger requires `evaluations:RunEval` on top of `triggers:CreateTrigger`: a trigger may only start what its creator could start directly.

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

Rather than waiting until 03:00, fire it now. Every starter works — manual, webhook, and `schedule` — and the firing always starts a **queued** run: a suite is one real generation per item, so blocking a scheduler tick on it is exactly the case [sync vs async](/docs/advanced/sync-and-async) rules out. The firing's `result.result_id` is the `evrun_…` to poll.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FIRING=$(soat fire-trigger --trigger-id "$TRIGGER_ID")
printf '%s' "$FIRING" | jq '{status, result}'

NIGHTLY_RUN_ID=$(printf '%s' "$FIRING" | jq -r '.result.result_id')

# → retry 60
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

The run records where it came from in `trigger_id`, and keeps it even if that trigger is later deleted — a run is a historical measurement, so nothing after the fact rewrites its origin.

The delivered payload carries the verdict **inline**:

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

That is not a convenience. This event **is** the promotion gate for anything automating the next step, and a gate that has to make a second call to learn its own answer is a gate that can fail open when that call does. Exactly one event fires per terminal run, from the single finalize path both run modes share.

:::note[The URL above is deliberately unroutable]

`http://127.0.0.1:9/…` cannot accept a POST, so the delivery attempt fails and retries — which is exactly why it is useful here: the delivery *record* still carries the event type and full payload, so you can inspect what SOAT sent without standing up a listener. Point this at a real endpoint and verify the signature; see [Webhooks](/docs/modules/webhooks).

:::

The trigger's `input` may also carry `agent_version` and `baseline_run_id`, which are passed to every run it starts. Both are validated at fire time, so a nightly schedule naming a version that no longer exists fails the **firing** — with the reason on the firing record — instead of creating a run that could never execute.

---

## What you built

| Need | Mechanism |
| --- | --- |
| "The suite ships with the agent" | `dataset` / `dataset_item` / `eval` / `trigger` in one formation template |
| "Nobody promotes on a hunch" | `set-agent-release --promotion-gate <eval>` |
| "Refuse, don't warn" | `409 PROMOTION_GATE_UNMET`, rollout left running |
| "Measure the canary, not the incumbent" | `start-eval-run --agent-version <canary>` |
| "Why was this promoted?" | `eval_run_id` on the version that went live |
| "Keep measuring after the rollout" | A `schedule` trigger with `target_type: eval` |
| "Tell my pipeline the verdict" | `eval_run.completed` / `eval_run.failed`, verdict inline |

Read next: [Agent Versioning and Canary Rollout](/docs/tutorials/agent-versioning-and-canary-rollout) for the rollout mechanics this builds on, [Formations](/docs/tutorials/formations) for declarative stacks, and [Evaluations](/docs/modules/evaluations) for the module reference.
