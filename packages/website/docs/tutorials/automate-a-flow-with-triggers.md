---
description: "Automate a SOAT flow by binding a manual, webhook, or schedule starter to an executable target with Triggers."
sidebar_position: 17
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Automate a Flow with Triggers

A [Trigger](/docs/modules/triggers) binds a **starter** — `manual`, `webhook`, or
`schedule` — to an **executable target** — an orchestration, agent, or tool. Every
firing is recorded as an auditable [firing record](/docs/modules/triggers#data-model),
and runs under a confined run-as identity derived from the trigger's creator. In this
tutorial you will:

1. Log in as admin.
2. Create a project.
3. Create a small orchestration to activate.
4. Bind a **manual** trigger to it and fire it, then inspect the firing record.
5. Schedule the same flow with a **cron** trigger.
6. Create a **webhook** trigger and read its signing secret.

By the end you will understand how one trigger resource activates any target from any
of the three starters.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, orchestrations, and the IAM model first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Server is at `http://localhost:5047`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

Export your server URL (used in subsequent steps):

```bash
export SOAT_BASE_URL=http://localhost:5047
```

CLI path flags in this tutorial are resource-specific and kebab-cased, for example `--trigger-id` and `--project-id`.

</TabItem>
<TabItem value="sdk" label="SDK">

All code snippets below use `SoatClient` instances. The authenticated instance is created in Step 1 after login.

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

Export your server URL once:

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [IAM — Authentication](/docs/modules/iam#authentication) for details on JWT tokens and the admin role.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password Admin1234!
```

The CLI prints a token. Save it to your profile:

```bash
soat configure
# Token: <paste token here>
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: session, error } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

if (error) throw new Error(JSON.stringify(error));

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: session.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

echo "Admin token: $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Triggers, orchestrations, and firings all live inside a [Project](/docs/modules/projects).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Triggers Tutorial" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Triggers Tutorial' },
});
const projectId = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Triggers Tutorial"}' | jq -r '.id')

echo "Project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an orchestration to activate

The trigger's target can be an orchestration, agent, or tool. Here we use a minimal
[Orchestration](/docs/modules/orchestrations) — a single `transform` node — so it runs
synchronously without needing an AI provider.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "daily-cycle" \
  --nodes '[{"id":"seed","type":"transform","expression":{"var":"input.cycle"},"state_mapping":{"state.cycle":{"var":"output.result"}}}]' \
  --edges '[]' | jq -r '.id')
echo "Orchestration: $ORCH_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestration } = await adminSoat.orchestrations.createOrchestration({
  body: {
    project_id: projectId,
    name: 'daily-cycle',
    nodes: [
      {
        id: 'seed',
        type: 'transform',
        expression: { var: 'input.cycle' },
        state_mapping: { 'state.cycle': { var: 'output.result' } },
      },
    ],
    edges: [],
  },
});
const orchestrationId = orchestration.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCH_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"daily-cycle","nodes":[{"id":"seed","type":"transform","expression":{"var":"input.cycle"},"state_mapping":{"state.cycle":{"var":"output.result"}}}],"edges":[]}' | jq -r '.id')

echo "Orchestration: $ORCH_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create a manual trigger

A `manual` [Trigger](/docs/modules/triggers) is fired on demand. `input` is the trigger's
static input, shallow-merged under each firing's runtime input. Creating a trigger requires
the target-start permission (`orchestrations:StartRun` here) — see
[Triggers — Run-as Identity](/docs/modules/triggers#run-as-identity).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TRIGGER_ID=$(soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name "run-daily-cycle" \
  --type manual \
  --target-type orchestration \
  --target-id "$ORCH_ID" \
  --input '{"cycle":"daily"}' | jq -r '.id')
echo "Trigger: $TRIGGER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: trigger } = await adminSoat.triggers.createTrigger({
  body: {
    project_id: projectId,
    name: 'run-daily-cycle',
    type: 'manual',
    target_type: 'orchestration',
    target_id: orchestrationId,
    input: { cycle: 'daily' },
  },
});
const triggerId = trigger.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TRIGGER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"run-daily-cycle","type":"manual","target_type":"orchestration","target_id":"'"$ORCH_ID"'","input":{"cycle":"daily"}}' | jq -r '.id')

echo "Trigger: $TRIGGER_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Fire the trigger and inspect the firing

Firing a `manual` trigger runs the target synchronously and returns a terminal
[firing record](/docs/modules/triggers#data-model). The fire-time `input` is merged over the
trigger's static `input`. Each firing is retained for auditing.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FIRING_ID=$(soat fire-trigger --trigger-id "$TRIGGER_ID" \
  --input '{"cycle":"2025-01-01"}' | jq -r '.id')
echo "Firing: $FIRING_ID"

# Inspect the terminal firing record (status is succeeded/failed).
soat get-trigger-firing --firing-id "$FIRING_ID"

# List all firings for this trigger.
soat list-trigger-firings --trigger-id "$TRIGGER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: firing } = await adminSoat.triggers.fireTrigger({
  path: { trigger_id: triggerId },
  body: { input: { cycle: '2025-01-01' } },
});
console.log(firing.status); // "succeeded"

const { data: detail } = await adminSoat.triggers.getTriggerFiring({
  path: { firing_id: firing.id },
});

const { data: firings } = await adminSoat.triggers.listTriggerFirings({
  query: { trigger_id: triggerId },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FIRING_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers/$TRIGGER_ID/fire" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"cycle":"2025-01-01"}}' | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/trigger-firings/$FIRING_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s "$SOAT_BASE_URL/api/v1/trigger-firings?trigger_id=$TRIGGER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

---

## Step 6 — Schedule the same flow with cron

A `schedule` trigger fires on a cron cadence instead of on demand. The `cron` field is a
strict 5-field UTC expression; the server computes `next_fire_at` and a background poller
fires due triggers exactly once, coalescing missed occurrences. See
[Triggers — Schedules and Misfire Coalescing](/docs/modules/triggers#schedules-and-misfire-coalescing).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SCHEDULE_ID=$(soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name "daily-cycle-8am" \
  --type schedule \
  --target-type orchestration \
  --target-id "$ORCH_ID" \
  --cron "0 8 * * *" \
  --input '{"cycle":"scheduled"}' | jq -r '.id')

# next_fire_at is server-computed in UTC.
soat get-trigger --trigger-id "$SCHEDULE_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: schedule } = await adminSoat.triggers.createTrigger({
  body: {
    project_id: projectId,
    name: 'daily-cycle-8am',
    type: 'schedule',
    target_type: 'orchestration',
    target_id: orchestrationId,
    cron: '0 8 * * *',
    input: { cycle: 'scheduled' },
  },
});
console.log(schedule.next_fire_at); // server-computed UTC timestamp
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"daily-cycle-8am","type":"schedule","target_type":"orchestration","target_id":"'"$ORCH_ID"'","cron":"0 8 * * *","input":{"cycle":"scheduled"}}'
```

</TabItem>
</Tabs>

The scheduler fires this trigger automatically; you do not fire it yourself.

---

## Step 7 — Trigger from an inbound webhook

A `webhook` trigger is fired by an external system POSTing to a public inbound endpoint.
Creating one returns a signing `secret` (also retrievable with `get-trigger-secret` and
replaceable with `rotate-trigger-secret`). See
[Triggers — Inbound Webhook Endpoint](/docs/modules/triggers#inbound-webhook-endpoint).
This is the inbound counterpart to outbound [Webhooks](/docs/modules/webhooks).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WEBHOOK_TRIGGER_ID=$(soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name "cycle-on-webhook" \
  --type webhook \
  --target-type orchestration \
  --target-id "$ORCH_ID" | jq -r '.id')

# Retrieve the current signing secret (webhook triggers only).
soat get-trigger-secret --trigger-id "$WEBHOOK_TRIGGER_ID"

# Rotate it when it may have leaked.
soat rotate-trigger-secret --trigger-id "$WEBHOOK_TRIGGER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: webhookTrigger } = await adminSoat.triggers.createTrigger({
  body: {
    project_id: projectId,
    name: 'cycle-on-webhook',
    type: 'webhook',
    target_type: 'orchestration',
    target_id: orchestrationId,
  },
});

const { data: secret } = await adminSoat.triggers.getTriggerSecret({
  path: { trigger_id: webhookTrigger.id },
});

const { data: rotated } = await adminSoat.triggers.rotateTriggerSecret({
  path: { trigger_id: webhookTrigger.id },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WEBHOOK_TRIGGER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/triggers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"cycle-on-webhook","type":"webhook","target_type":"orchestration","target_id":"'"$ORCH_ID"'"}' | jq -r '.id')

SECRET=$(curl -s "$SOAT_BASE_URL/api/v1/triggers/$WEBHOOK_TRIGGER_ID/secret" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.secret')

# An external system fires the trigger by POSTing to the public inbound endpoint,
# signing the raw body with HMAC-SHA256 using the secret above. No bearer token.
BODY='{"cycle":"from-webhook"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -s -X POST "$SOAT_BASE_URL/hooks/triggers/$WEBHOOK_TRIGGER_ID" \
  -H "Content-Type: application/json" \
  -H "X-Soat-Signature: sha256=$SIG" \
  -d "$BODY"
# → 202 Accepted { "firing_id": "...", "trigger_id": "...", "status": "running" }
```

</TabItem>
</Tabs>

The inbound `POST /hooks/triggers/{trigger_id}` call is made by the **external system**, not
the SOAT CLI — it carries no bearer token and is authenticated solely by the
`X-Soat-Signature` HMAC header over the raw request body.

---

## Recap

You bound one orchestration to three different starters:

- a **manual** trigger you fired on demand and audited via its firing record;
- a **schedule** trigger the built-in poller fires on a cron cadence;
- a **webhook** trigger an external system fires with an HMAC-signed inbound request.

The same pattern works with `target_type: agent` and `target_type: tool`. To ship a trigger
alongside the resource it activates as a single deployable stack, declare it as a `trigger`
resource in a [Formation](/docs/modules/formations) template — see
[Triggers — Formation Support](/docs/modules/triggers#formation-support).
