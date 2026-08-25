---
description: "Bind a starter — manual, webhook, schedule, or event — to an executable target in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Triggers

Bind a **starter** (manual, webhook, schedule, or event) to an **executable
target** (an orchestration, an agent, or a tool) so work runs without a client
making an API call at the moment it should happen.

## Overview

A trigger is a first-class, project-scoped resource. It connects one _starter
type_ (manual, webhook, schedule, or event) to one _target_ (orchestration,
agent, tool, or eval) — any starter can activate any target — and records every
activation as an auditable **trigger firing**.

Firings execute in-process: a manual fire is **synchronous** and returns the
terminal firing; webhook, schedule, and event fires are **fire-and-forget** and
the firing record is the source of truth for the outcome.

> See the [Permissions Reference](../permissions.md#triggers) for the IAM action
> strings for this module.

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
| `type`         | `manual` \| `webhook` \| `schedule` \| `event` | Starter type. **Immutable after creation**                                   |
| `target_type`  | `orchestration` \| `agent` \| `tool` \| `eval` | Kind of resource activated                                                   |
| `target_id`    | string                                  | Public ID of the target; must exist in the same project at create/update time     |
| `action`       | string \| null                          | Tool targets only: the action for `builtin`/`mcp` tools (required for those, rejected otherwise) |
| `input`        | object \| null                          | Static input, shallow-merged under fire-time input (fire-time keys win)           |
| `cron`         | string \| null                          | 5-field cron expression (UTC). Required iff `type=schedule`, rejected otherwise   |
| `event_pattern`| string \| null                          | Internal-event subscription pattern. Required iff `type=event`, rejected otherwise |
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
| `source`       | `manual` \| `webhook` \| `schedule` \| `event`      | How _this_ firing started (manually firing a webhook trigger records `manual`) |
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
| `manual`   | [`POST /api/v1/triggers/{id}/fire`](/docs/api/triggers/fire-trigger)             | Synchronous; the response is the terminal firing          |
| `webhook`  | Signed `POST /hooks/triggers/{trigger_id}` (see below) | Has a `secret`; verified with HMAC-SHA256                 |
| `schedule` | The built-in scheduler on a cron cadence      | Requires `cron`; `next_fire_at` is server-computed in UTC |
| `event`    | An internal platform event, in-process        | Requires `event_pattern`; no HTTP hop, no secret (see below) |

The `type` is fixed at creation.

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
  `builtin`/`mcp` tools. `client`-type tools cannot execute server-side and are
  rejected at trigger creation time.
- **Eval** → starts a **queued** run; `input.agent_version` and
  `input.baseline_run_id` are forwarded, anything else is ignored, and the
  firing's `result.result_id` is the `evrun_…` id to poll. See
  [scheduled runs](./evaluations.md#scheduled-runs).

Each target type also has a permission: a caller can only bind (or fire) a
trigger to a target it could start itself — `orchestrations:StartRun`,
`agents:CreateAgentGeneration`, `tools:CallTool`, or `evaluations:RunEval`.

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
  timing-safe. The secret is stored encrypted at rest (AES-256-GCM, the same
  scheme as [secrets](./secrets.md)), keyed by `SECRETS_ENCRYPTION_KEY`, and is
  decrypted only to verify an inbound signature or to return it to a caller
  with `triggers:GetTriggerSecret`.

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

Before wiring this endpoint to a real external system, use
[`soat listen`](../cli/usage.md#testing-webhooks-locally) to receive and verify
signed deliveries on your local machine.

Signature verification on the receiving side mirrors the outbound
[webhooks](./webhooks.md) convention.

### Event Triggers

An `event` trigger subscribes directly to SOAT's internal event bus — the same
bus [webhooks](./webhooks.md) deliver from — so "when a document finishes
ingesting, run the summarizer agent" is a subscription rather than a loopback:

```json
{
  "name": "summarize-ingested",
  "type": "event",
  "event_pattern": "documents.ingested",
  "target_type": "agent",
  "target_id": "agent_ABC"
}
```

Nothing leaves the process. There is no publicly reachable URL to expose, no
HMAC to verify against your own event, and no second secret and retry policy for
what is one logical hop — which is what the webhook-subscription-to-inbound-hook
pattern this replaces cost.

**The pattern grammar** is the one webhook subscriptions already match:

| Pattern              | Matches                                              |
| -------------------- | ---------------------------------------------------- |
| `documents.ingested` | that event only                                      |
| `documents.*`        | every event in the `documents` namespace             |
| `*`                  | every event in the project                           |

A pattern whose first segment names a **platform namespace** must resolve to a
[registered event](./webhooks.md#events) — `documents.ingsted` is rejected at
write time with `400 INVALID_EVENT_PATTERN` rather than silently never matching.
A name outside every platform namespace (`orders.shipped`) is accepted as
written, because an orchestration [`emit_event` node](./orchestrations.md) emits
names SOAT does not own and subscribing to one is a first-class use of this type.

**The event payload is the firing input**, carried opaquely — the same envelope a
webhook subscriber receives:

```json
{
  "event": "documents.ingested",
  "project_id": "proj_ABC",
  "resource_type": "document",
  "resource_id": "doc_XYZ",
  "data": { "...": "..." },
  "timestamp": "2026-08-25T12:00:00.000Z"
}
```

For an agent target that object is JSON-encoded into a user message; for an
orchestration target it is the run input, so an `input_schema` sees these keys.
Set the trigger's static `input` to add fields; fire-time keys win as always.

**Scope and gating** work exactly as they do for webhook subscriptions: only
events from the trigger's own project are matched, and an attached `policy_id`
is evaluated against the event (event name as the action, the event's resource as
the SRN) before anything is dispatched.

#### Loops and Cost

Two guards apply to event triggers specifically, because a reactive edge can feed
itself in a way a schedule cannot.

**Causation depth.** Every event carries the chain of trigger firings that led to
it. A trigger refuses to extend a chain that already names it — an agent that
emits an event that runs that agent is stopped on the *first* recurrence — and
refuses any chain that has already run `5` hops deep. Either refusal records a
`failed` firing with `error.code = TRIGGER_CAUSATION_LIMIT`, and files an
[`event_trigger_loop` exception](./exceptions.md) (severity `warning`, deduped on
the trigger) so the loop is triaged rather than merely stopped. This is the same
posture as the workflow [automation chain budget](./workflows.md): a backstop,
not a design — bound the cycle in the wiring you write.

**Quota admission.** A firing is admitted against the project's `requests`
[quotas](./quotas.md) *before* dispatch, which is the only place a cap can act:
an event trigger never passes through the HTTP middleware that admits every other
request, so a `*` pattern on an agent target would otherwise be an uncapped spend
path. A breach records a `failed` firing with `error.code = QUOTA_EXCEEDED` and
starts nothing. Only `project`-scope quotas apply — the firing arrived on the bus,
on no API key, and an `api_key`-scope cap is a cap on a credential.

#### Delivery Guarantees

An event trigger inherits the bus's guarantees, which are deliberately modest:

- **Best-effort, in-process.** An event is not persisted before dispatch. A
  process that dies between the emit and the firing record loses that firing —
  unlike a schedule, which is recovered from the database on the next tick.
- **Unordered.** Two events emitted in sequence may fire in either order, and two
  triggers on the same event fire independently.
- **At-most-once**, per emitting process.

Use an event trigger for reactive automation whose value is promptness. When the
work must not be lost, keep a `schedule` trigger over the same condition as the
backstop — the two compose, and a target that is idempotent per resource makes
the overlap harmless.

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

### Common Errors

| Code                          | Status | Cause                                                                                                        | What to do                                                                                          |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `INVALID_CRON_EXPRESSION`      | `400`  | `cron` is missing a field or otherwise not a valid 5-field expression                                          | Fix the expression; it is always evaluated in **UTC**                                                |
| `INVALID_EVENT_PATTERN`        | `400`  | `event_pattern` is malformed, or names a platform namespace with no registered event matching it (a typo)     | Use `*`, `prefix.*`, or an exact registered event name — see [Event Triggers](#event-triggers)       |
| `TRIGGER_CAUSATION_LIMIT`      | `409`  | An event trigger refused to extend the causal chain that reached it — it is already in the chain, or the chain ran past the depth cap | Recorded on the firing, never returned to a caller. Break the cycle in the wiring; see [Loops and Cost](#loops-and-cost) |
| `TRIGGER_TARGET_NOT_FOUND`     | `400`  | `target_id` does not exist in the trigger's project                                                            | Verify the target ID and that it belongs to the same project as the trigger                          |
| `TRIGGER_ACTION_NOT_ALLOWED`   | `400`  | An invalid field combination for `type`/`target_type` — e.g. `cron` on a non-`schedule` trigger, `event_pattern` on a non-`event` trigger (or a missing one on an `event` trigger), `action` on a non-tool target, or a `client`-type tool as the target | Check the [Trigger Types](#trigger-types) and [Targets and Input](#targets-and-input) rules          |
| `TRIGGER_INPUT_INVALID`        | `400`  | Fire-time input doesn't satisfy the target — empty agent input, or a field missing/mismatched against an orchestration's `input_schema` | Supply the required input fields for the target type                                                 |
| `TRIGGER_NOT_ACTIVE`           | `409`  | The trigger's `active` field is `false`                                                                        | `PATCH` the trigger with `active: true` before firing                                                |
| `TRIGGER_CREATOR_UNAVAILABLE`  | `409`  | The user who created the trigger no longer exists                                                              | The trigger cannot fire under a deleted user's identity — recreate it under a live user              |
| `TRIGGER_RECURSION_FORBIDDEN`  | `403`  | A trigger-scoped run-as credential tried to call the fire endpoint                                             | Fire the trigger with a user/API-key credential; a trigger cannot fire another trigger               |
| `NAME_CONFLICT`                | `409`  | A trigger with that `name` already exists in the project                                                       | Choose a different name                                                                              |
| `POLICY_HAS_DEPENDENTS`        | `409`  | Attempted to delete a policy while a trigger's `policy_id` still references it                                | Detach the policy from the trigger first, or delete the trigger                                      |
| `RESOURCE_NOT_FOUND`           | `404`  | The trigger or firing ID doesn't exist (or isn't in the caller's project)                                      | Check the ID and project scope                                                                        |
| `SECRET_NOT_DECRYPTABLE`       | `500`  | The stored signing secret is not valid ciphertext — written before secret-at-rest encryption, or encrypted under a different `SECRETS_ENCRYPTION_KEY` | Rotate the secret ([`POST /triggers/{id}/rotate-secret`](/docs/api/triggers/rotate-trigger-secret)) to replace it, or restore the original key. A webhook trigger in this state cannot authenticate inbound deliveries until it is fixed |

For the inbound webhook endpoint's error responses (bad signature, oversized body, inactive trigger, …), see the [table above](#inbound-webhook-endpoint).

**A `schedule` trigger never fires:** confirm `active` is `true`, `next_fire_at` is set, and the server wasn't started with `SOAT_TRIGGER_SCHEDULER_DISABLED=true`.

**A firing's `status` never leaves `pending`/`running`:** webhook and schedule firings execute fire-and-forget; poll [`GET /trigger-firings/{id}`](/docs/api/triggers/get-trigger-firing) for the terminal `status`. There is no automatic retry — inspect `error.code`/`error.message` and re-fire manually.

### Formation Support

Triggers can be declared in a [Formation](./formations.md) template as the
`trigger` resource type, so an Agent Squad ships with its schedule. Template
properties are `name`, `description`, `type`, `target_type`, `target_id`,
`action`, `input`, `cron`, `event_pattern`, `active`, and `policy_id`. Use
`{ "ref": "LogicalId" }`
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

### Create an event trigger

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-trigger \
  --project-id proj_ABC \
  --name "Summarize Ingested" \
  --type event \
  --event-pattern documents.ingested \
  --target-type agent \
  --target-id agent_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.triggers.createTrigger({
  body: {
    project_id: 'proj_ABC',
    name: 'Summarize Ingested',
    type: 'event',
    event_pattern: 'documents.ingested',
    target_type: 'agent',
    target_id: 'agent_ABC',
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
    "name": "Summarize Ingested",
    "type": "event",
    "event_pattern": "documents.ingested",
    "target_type": "agent",
    "target_id": "agent_ABC"
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
