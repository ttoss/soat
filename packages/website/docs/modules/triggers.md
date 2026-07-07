import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Triggers

Bind a **starter** (manual, webhook, or schedule) to an **executable target**
(an orchestration, an agent, or a tool) so work runs without a client making an
API call at the moment it should happen.

## Overview

A trigger is a first-class, project-scoped resource. It connects one _starter
type_ to one _target_ and records every activation as an auditable **trigger
firing**. This delivers a full activation matrix — any starter can activate any
target:

| Starter ↓ / Target → | Orchestration | Agent | Tool |
| -------------------- | ------------- | ----- | ---- |
| **Manual** — `POST /api/v1/triggers/{id}/fire` | ✅ | ✅ | ✅ |
| **Webhook** — signed `POST /hooks/triggers/{trigger_id}` | ✅ | ✅ | ✅ |
| **Schedule** — 5-field cron (UTC) | ✅ | ✅ | ✅ |

Firings execute in-process: a manual fire is **synchronous** and returns the
terminal firing; webhook and schedule fires are **fire-and-forget** and the
firing record is the source of truth for the outcome.

> See the [Permissions Reference](../permissions.md) for the IAM action strings
> for this module.

## Related Tutorials

- [Automate a Flow with Triggers](/docs/tutorials/automate-a-flow-with-triggers) — bind one orchestration to manual, schedule, and webhook starters.

## Data Model

### Trigger

| Field          | Type                                    | Description                                                                       |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| `id`           | string                                  | Public identifier (`trg_…`)                                                       |
| `project_id`   | string                                  | ID of the owning project (hard security boundary)                                 |
| `name`         | string                                  | Human-readable name, unique per project                                           |
| `description`  | string \| null                          | Optional description                                                              |
| `type`         | `manual` \| `webhook` \| `schedule`     | Starter type. **Immutable after creation**                                        |
| `target_type`  | `orchestration` \| `agent` \| `tool`    | Kind of resource activated                                                        |
| `target_id`    | string                                  | Public ID of the target; must exist in the same project at create/update time     |
| `action`       | string \| null                          | Tool targets only: the action for `soat`/`mcp` tools (required for those, rejected otherwise) |
| `input`        | object \| null                          | Static input, shallow-merged under fire-time input (fire-time keys win)           |
| `cron`         | string \| null                          | 5-field cron expression (UTC). Required iff `type=schedule`, rejected otherwise   |
| `active`       | boolean                                 | Inactive triggers never fire                                                      |
| `policy_id`    | string \| null                          | Optional boundary policy that further restricts firings (see [Run-as Identity](#run-as-identity)) |
| `secret`       | string                                  | Webhook type only. Returned **only** on create, rotate, and `GET …/secret`        |
| `next_fire_at` | string \| null                          | Read-only. Schedule type only. Server-computed next fire time                     |
| `created_at`   | string                                  | ISO 8601 creation timestamp                                                       |
| `updated_at`   | string                                  | ISO 8601 last-updated timestamp                                                   |

### Trigger Firing

| Field          | Type                                                | Description                                                            |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `id`           | string                                              | Public identifier (`trg_fire_…`)                                      |
| `trigger_id`   | string                                              | Public ID of the trigger that fired                                   |
| `project_id`   | string                                              | ID of the owning project                                              |
| `source`       | `manual` \| `webhook` \| `schedule`                 | How _this_ firing started (manually firing a webhook trigger records `manual`) |
| `status`       | `pending` \| `running` \| `succeeded` \| `failed`   | Firing lifecycle status                                               |
| `input`        | object \| null                                      | Effective (post-merge) input snapshot                                 |
| `result`       | object \| null                                      | `{ target_type, result_id, status, output }` — `result_id` is the run/generation public ID; `output` truncated |
| `error`        | object \| null                                      | `{ code, message, meta }` when the firing failed                      |
| `started_at`   | string \| null                                      | ISO 8601 timestamp when execution began                               |
| `completed_at` | string \| null                                      | ISO 8601 timestamp when the firing reached a terminal status          |

## Key Concepts

### Trigger Types

| Type       | Started by                                    | Notes                                                     |
| ---------- | --------------------------------------------- | --------------------------------------------------------- |
| `manual`   | `POST /api/v1/triggers/{id}/fire`             | Synchronous; the response is the terminal firing          |
| `webhook`  | Signed `POST /hooks/triggers/{trigger_id}` (see below) | Has a `secret`; verified with HMAC-SHA256                 |
| `schedule` | The built-in scheduler on a cron cadence      | Requires `cron`; `next_fire_at` is server-computed in UTC |

The `type` is fixed at creation. To change how a trigger starts, create a new
one.

### Targets and Input

The effective input is a shallow merge — fire-time input wins over the trigger's
static `input`:

```
effective_input = { ...trigger.input, ...fire_time_input }
```

How the effective input reaches each target:

- **Orchestration** → passed as the run `input`. Validated against the
  orchestration's `input_schema` when declared (lightweight `required` +
  primitive-type checks); a violation returns `400` with details.
- **Agent** → turned into messages: `input.messages` (an array of
  `{ role, content }`) is used verbatim; otherwise `input.message` (a string)
  becomes a single user message; otherwise a non-empty object is JSON-encoded
  into a user message. Empty input returns `400 TRIGGER_INPUT_INVALID`.
- **Tool** → passed as the tool call input, with `trigger.action` forwarded for
  `soat`/`mcp` tools. `client`-type tools cannot execute server-side and are
  rejected at trigger creation time.

### Firing Status Semantics

`succeeded` means the target invocation completed **without throwing** — a
_paused_ orchestration run or a `requires_action` agent generation still counts
as a successful firing, and the target's own status is visible in
`result.status`. `failed` records the error, including a `failed` orchestration
run.

### Run-as Identity

Every firing — manual, webhook, or schedule — executes as the **trigger
creator**. At fire time the server mints a short-lived internal token that is
threaded into the target execution so downstream SOAT-type tools authenticate as
that identity. Permissions are resolved as:

> **creator's current policies (ceiling) ∩ optional attached `policy_id`
> (boundary)**, hard-confined to the trigger's project.

Because the check runs against the creator's _current_ policies at every fire,
revoking the creator's access takes effect immediately.

Security invariants:

- **No privilege escalation.** Creating a trigger (or changing its target) also
  requires the caller to hold the target-start action —
  `orchestrations:StartRun`, `agents:CreateAgentGeneration`, or `tools:CallTool`
  — and the same check re-runs at every fire.
- **No recursion.** Trigger-scoped credentials cannot call the fire endpoint
  (`403`), so a trigger cannot fire another trigger in an unbounded loop.
- **Fail closed.** If the creator is deleted the trigger is kept but firing fails
  with `409 TRIGGER_CREATOR_UNAVAILABLE`. An attached policy cannot be deleted
  while a trigger references it (`409 POLICY_HAS_DEPENDENTS`). A deleted target
  causes the firing to record the error.
- **Secret hygiene.** Webhook secrets are 32 random bytes (hex), never returned
  in list/get responses, rotate on demand, and inbound signatures are compared
  timing-safe.

### Inbound Webhook Endpoint

A `webhook` trigger is fired by an external caller through a public endpoint that
lives **outside `/api/v1`**:

```
POST /hooks/triggers/{trigger_id}
```

This endpoint takes no bearer token, applies no snake→camel case transform to the
payload, and is excluded from the generated SDK/CLI/MCP surface. The caller signs
the **raw request body**:

```
X-Soat-Signature: sha256=<hex(HMAC-SHA256(secret, body))>
```

Responses:

| Condition                                   | Status | Body                                    |
| ------------------------------------------- | ------ | --------------------------------------- |
| Unknown or non-webhook trigger              | `404`  | Existence is not leaked                 |
| Missing or bad signature                    | `401`  |                                         |
| Inactive trigger (after a valid signature)  | `409`  |                                         |
| Invalid JSON body                           | `400`  |                                         |
| Orchestration `input_schema` violation      | `400`  | With details                            |
| Accepted                                    | `202`  | `{ firing_id, trigger_id, status }`     |

The request body becomes the fire-time input (a non-object JSON value is wrapped
as `{ "payload": … }`); the body is capped at 1 MiB. The firing then executes in
the background — poll the firing record for the outcome.

Verifying a signature on the receiving side mirrors the outbound
[webhooks](./webhooks.md) convention:

```js
const crypto = require('crypto');

const sign = (secret, rawBody) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
```

### Schedules and Misfire Coalescing

A `schedule` trigger is evaluated by a DB-driven poller. Cron expressions are
strictly 5-field and evaluated in **UTC**; an invalid expression is rejected at
create/update with `400 INVALID_CRON_EXPRESSION`. The scheduler is multi-instance
safe — each due trigger is claimed with an atomic conditional update, so exactly
one instance fires it.

**Misfire coalescing:** `next_fire_at` is recomputed from _now_ after each claim.
Firings that were missed while the server was down **coalesce into at most one**
catch-up firing on restart, and then the normal schedule resumes — there is no
unbounded catch-up storm.

### Formation Support

Triggers can be declared in a [Formation](./formations.md) template as the
`trigger` resource type, so an Agent Squad ships with its schedule. Template
properties are `name`, `description`, `type`, `target_type`, `target_id`,
`action`, `input`, `cron`, `active`, and `policy_id`. Use `{ "ref": "LogicalId" }`
for `target_id`/`policy_id` to wire a trigger to another resource in the same
template, and capture a webhook trigger's server-generated secret as an output
with `ref_attr`:

```json
{
  "resources": {
    "DailyFlow": { "type": "orchestration", "properties": { "...": "..." } },
    "DailyCycle": {
      "type": "trigger",
      "properties": {
        "name": "daily-cycle",
        "type": "schedule",
        "target_type": "orchestration",
        "target_id": { "ref": "DailyFlow" },
        "cron": "0 8 * * *",
        "input": { "cycle": "daily" },
        "active": true
      }
    }
  }
}
```

## Configuration

| Environment Variable                 | Required | Description                                                  |
| ------------------------------------ | -------- | ------------------------------------------------------------ |
| `SOAT_TRIGGER_SCHEDULER_INTERVAL_MS` | No       | Scheduler poll interval in milliseconds (default `30000`)    |
| `SOAT_TRIGGER_SCHEDULER_DISABLED`    | No       | Set to `true` to disable the schedule poller                 |
| `SOAT_TRIGGER_TOKEN_TTL`             | No       | TTL of the minted run-as token (default `1h`)                |

## Examples

### Create a schedule trigger

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-trigger \
  --project-id proj_ABC \
  --name "Daily Cycle" \
  --type schedule \
  --target-type orchestration \
  --target-id orch_XYZ \
  --cron "0 8 * * *"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.triggers.createTrigger({
  body: {
    project_id: 'proj_ABC',
    name: 'Daily Cycle',
    type: 'schedule',
    target_type: 'orchestration',
    target_id: 'orch_XYZ',
    cron: '0 8 * * *',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/triggers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Daily Cycle",
    "type": "schedule",
    "target_type": "orchestration",
    "target_id": "orch_XYZ",
    "cron": "0 8 * * *"
  }'
```

</TabItem>
</Tabs>

### Fire a trigger manually

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat fire-trigger --trigger-id trg_ABC --input '{"reason":"manual run"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.triggers.fireTrigger({
  params: { path: { trigger_id: 'trg_ABC' } },
  body: { input: { reason: 'manual run' } },
});
if (error) throw new Error(JSON.stringify(error));
// data is the terminal firing: data.status is 'succeeded' or 'failed'
// data.result.result_id references the run / generation that was started
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/triggers/trg_ABC/fire \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "input": { "reason": "manual run" } }'
```

</TabItem>
</Tabs>

### Call the inbound webhook endpoint

```bash
BODY='{"event":"push","ref":"main"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

curl -X POST https://api.example.com/hooks/triggers/trg_ABC \
  -H "Content-Type: application/json" \
  -H "X-Soat-Signature: $SIG" \
  -d "$BODY"
# → 202 { "firing_id": "trg_fire_...", "trigger_id": "trg_ABC", "status": "pending" }
```

### List a trigger's firings

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-trigger-firings --trigger-id trg_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.triggers.listTriggerFirings({
  params: { query: { trigger_id: 'trg_ABC' } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET "https://api.example.com/api/v1/trigger-firings?trigger_id=trg_ABC" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
