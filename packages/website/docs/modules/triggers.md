---
description: "Bind a starter — manual, webhook, schedule, or event — to an executable target in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Triggers

Bind a **starter** (manual, webhook, schedule, or event) to an **executable
target** (orchestration, agent, tool, or eval) so work runs without a client
call at the moment it should happen.

## Overview

A trigger is a project-scoped resource connecting one starter type to one
target; any starter can activate any target. Every activation is recorded as a
**trigger firing**. A manual fire is **synchronous** and returns the terminal
firing; webhook, schedule, and event fires are **fire-and-forget** and the
firing record holds the outcome.

> See the [Permissions Reference](../permissions.md#triggers) for the IAM action
> strings for this module.

## Related Tutorials

- [Automate a Flow with Triggers](/docs/tutorials/automate-a-flow-with-triggers)

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

Effective input is a shallow merge; fire-time input wins:

```
effective_input = { ...trigger.input, ...fire_time_input }
```

Per target:

- **Orchestration** → the run `input`, validated against a declared
  `input_schema` (`required` + primitive-type checks); a violation returns `400`.
- **Agent** → messages: `input.messages` (array of `{ role, content }`) verbatim; else
  `input.message` (string) as one user message; else a non-empty object
  JSON-encoded into a user message. Empty input returns
  `400 TRIGGER_INPUT_INVALID`.
- **Tool** → the tool call input, with `trigger.action` forwarded for
  `builtin`/`mcp` tools. `client`-type tools are rejected at creation.
- **Eval** → a **queued** run; `input.agent_version` and
  `input.baseline_run_id` are forwarded, anything else ignored;
  `result.result_id` is the `evrun_…` id to poll. See
  [scheduled runs](./evaluations.md#scheduled-runs).

A caller can only bind or fire a trigger to a target it could start itself:
`orchestrations:StartRun`, `agents:CreateAgentGeneration`, `tools:CallTool`, or
`evaluations:RunEval`.

### Firing Status Semantics

`succeeded` means the target invocation completed **without throwing**; a
paused orchestration run or a `requires_action` generation is still a succeeded
firing, with the target's own status in `result.status`. `failed` records the
error, including a `failed` orchestration run.

### Run-as Identity

Every firing executes as the **trigger creator**: the server mints a
short-lived internal token so downstream SOAT-type tools authenticate as that
identity. Permissions = **creator's current policies (ceiling) ∩ optional
attached `policy_id` (boundary)**, confined to the trigger's project. The check
uses the creator's _current_ policies at every fire, so revoking access takes
effect immediately.

A trigger declared in a [formation](./formations.md) template has the deploying
caller as creator; re-deploying as a different caller re-points the run-as
identity.

Security invariants:

- **No privilege escalation.** Creating a trigger requires the target-start
  action (`orchestrations:StartRun`, `agents:CreateAgentGeneration`, or
  `tools:CallTool`); the check re-runs at every fire, and
  [`PATCH /api/v1/triggers/{trigger_id}`](/docs/api/triggers/update-trigger)
  re-asks it whenever `target_type` or `target_id` changes. An updater who
  could not start the new target gets `403` and the trigger keeps its target.
- **No recursion.** Trigger-scoped credentials cannot call the fire endpoint
  (`403`).
- **Fail closed.** A deleted creator keeps the trigger but firing fails with
  `409 TRIGGER_CREATOR_UNAVAILABLE`. A referenced policy cannot be deleted
  (`409 POLICY_HAS_DEPENDENTS`). A deleted target makes the firing record the
  error.
- **Secret hygiene.** Webhook secrets are 32 random bytes (hex), never returned
  in list/get responses, rotatable, compared timing-safe, and stored
  AES-256-GCM encrypted (as [secrets](./secrets.md)) under
  `SECRETS_ENCRYPTION_KEY`; decrypted only to verify a signature or for a
  caller with `triggers:GetTriggerSecret`.

### Inbound Webhook Endpoint

A `webhook` trigger is fired through a public endpoint **outside `/api/v1`**:

```
POST /hooks/triggers/{trigger_id}
```

No bearer token, no snake→camel transform of the payload, not in the generated
SDK/CLI/MCP surface. The caller signs the **raw request body**:

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

The body (max 1 MiB) is the fire-time input; a non-object JSON value is wrapped
as `{ "payload": … }`. The firing runs in the background; poll the firing
record. Test locally with
[`soat listen`](../cli/usage.md#testing-webhooks-locally). The signature scheme
mirrors outbound [webhooks](./webhooks.md).

### Event Triggers

An `event` trigger subscribes to SOAT's internal event bus (the one
[webhooks](./webhooks.md) deliver from), so no public URL, HMAC, secret or
retry policy is needed for an in-process hop:

```json
{
  "name": "summarize-ingested",
  "type": "event",
  "event_pattern": "documents.ingested",
  "target_type": "agent",
  "target_id": "agent_ABC"
}
```

**Pattern grammar** (same as webhook subscriptions):

| Pattern              | Matches                                              |
| -------------------- | ---------------------------------------------------- |
| `documents.ingested` | that event only                                      |
| `documents.*`        | every event in the `documents` namespace             |
| `*`                  | every event in the project                           |

A pattern whose first segment is a **platform namespace** must resolve to a
[registered event](../webhook-events.md); `documents.ingsted` is rejected with
`400 INVALID_EVENT_PATTERN`. A name outside every platform namespace
(`orders.shipped`) is accepted as written, since an orchestration
[`emit_event` node](./orchestrations.md) emits names SOAT does not own.

**The event payload is the firing input**, the same envelope a webhook
subscriber receives:

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

For an agent target it is JSON-encoded into a user message; for an
orchestration target it is the run input (an `input_schema` sees these keys).
Static `input` adds fields; fire-time keys win.

**Scope and gating** match webhook subscriptions: only the trigger's own
project's events match, and an attached `policy_id` is evaluated against the
event (event name as action, event resource as SRN) before dispatch.

#### Loops and Cost

Two guards apply to event triggers:

**Causation depth.** Every event carries the chain of trigger firings that led
to it. A trigger refuses to extend a chain that already names it (stopped on the
first recurrence) or that is already `5` hops deep. Either refusal records a
`failed` firing with `error.code = TRIGGER_CAUSATION_LIMIT` and files an
[`event_trigger_loop` exception](./exceptions.md) (severity `warning`, deduped
on the trigger). Like the workflow [automation chain budget](./workflows.md),
this is a backstop: bound the cycle in your wiring.

**Quota admission.** A firing is admitted against the project's `requests`
[quotas](./quotas.md) before dispatch (an event trigger bypasses the HTTP
middleware that admits other requests). A breach records a `failed` firing with
`error.code = QUOTA_EXCEEDED` and starts nothing. Only `project`-scope quotas
apply; the firing arrives on no API key, and an `api_key`-scope cap is a cap on a credential.

#### Delivery Guarantees

An event trigger inherits the bus's guarantees:

- **Best-effort, in-process.** Events are not persisted before dispatch; a
  process dying between emit and firing record loses that firing (a schedule is
  recovered from the database on the next tick).
- **Unordered.** Sequential events may fire in either order; triggers on the
  same event fire independently.
- **At-most-once**, per emitting process.

When work must not be lost, keep a `schedule` trigger over the same condition as
a backstop; an idempotent target makes the overlap harmless.

### Schedules and Misfire Coalescing

A `schedule` trigger is evaluated by a DB-driven poller. Cron expressions are
strictly 5-field, evaluated in **UTC**; an invalid one is rejected with
`400 INVALID_CRON_EXPRESSION`. Each due trigger is claimed with an atomic
conditional update, so exactly one instance fires it.

**Misfire coalescing:** `next_fire_at` is recomputed from _now_ after each
claim, so firings missed while the server was down **coalesce into at most one**
catch-up firing on restart.

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
| `SECRET_NOT_DECRYPTABLE`       | `500`  | The stored signing secret is not valid ciphertext — encrypted under a different `SECRETS_ENCRYPTION_KEY` | Rotate the secret ([`POST /triggers/{id}/rotate-secret`](/docs/api/triggers/rotate-trigger-secret)) to replace it, or restore the original key. A webhook trigger in this state cannot authenticate inbound deliveries until it is fixed |

Inbound webhook endpoint errors: see the [table above](#inbound-webhook-endpoint).

**A `schedule` trigger never fires:** confirm `active` is `true`, `next_fire_at` is set, and the server was not started with `SOAT_TRIGGER_SCHEDULER_DISABLED=true`.

**A firing's `status` never leaves `pending`/`running`:** webhook and schedule firings are fire-and-forget; poll [`GET /trigger-firings/{id}`](/docs/api/triggers/get-trigger-firing). There is no automatic retry; inspect `error.code`/`error.message` and re-fire manually.

### Formation Support

A [Formation](./formations.md) template declares a trigger as the `trigger`
resource type with properties `name`, `description`, `type`, `target_type`,
`target_id`, `action`, `input`, `cron`, `event_pattern`, `active`, and
`policy_id`. Use `{ "ref": "LogicalId" }` for `target_id`/`policy_id`, and
`ref_attr` to capture a webhook trigger's generated secret as an output:

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
