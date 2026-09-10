---
description: "Generation records track individual LLM runs started by agents, including lifecycle status and failure details."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Generations

Generation records track individual LLM generation runs started by agents, including their lifecycle status and any failure details.

## Overview

Every agent generation ([`POST /agents/:id/generate`](/docs/api/agents/create-agent-generation), session generation, sub-agent calls) creates a generation record before the model is called. The record tracks the run through its lifecycle and, when the run fails, stores a structured error payload so failed generations are distinguishable from pending ones.

List with [`GET /generations`](/docs/api/generations/list-generations) (filter by `agent_id`, `trace_id`, or `status`); read one with [`GET /generations/:generation_id`](/docs/api/generations/get-generation).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Debug Session, Generation, and Trace History - Step 3 (Run two generations)](/docs/tutorials/debug-session-generation-trace-history#step-3---run-two-generations-and-capture-generation_id--trace_id)
- [Data Retention and Zero-Retention - Step 5 (Purge a single generation)](/docs/tutorials/data-retention-and-zero-retention#step-5--purge-a-single-generation)
- [Agent Versioning and Canary Rollout - Step 6 (Read which version served a generation)](/docs/tutorials/agent-versioning-and-canary-rollout#step-6--run-traffic-and-read-which-version-served-it)

## Data Model

| Field                       | Type           | Description                                                                                          |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                        | string         | Public identifier for the generation                                                                 |
| `project_id`                | string         | Project the generation belongs to                                                                    |
| `agent_id`                  | string         | Agent that ran the generation                                                                        |
| `trace_id`                  | string         | Trace this generation belongs to                                                                     |
| `initiator_generation_id`   | string \| null | Generation that triggered this one. Set only for sub-agent invocations; `null` for top-level generations |
| `chain_id`                  | string \| null | [Continuation chain](./chains.md) this generation belongs to — set on every member including the root; `null` when it is not part of one |
| `session_id`                | string \| null | [Session](./sessions.md) this generation was dispatched through; `null` when it was started outside one |
| `actor_id`                  | string \| null | End-user [actor](./actors.md) the generation is attributed to, derived from the session; `null` when there is none |
| `started_by_principal_type` | string \| null | Principal kind that started the generation — `user` or `api_key` (see [Starting principal](#starting-principal)) |
| `started_by_principal_id`   | string \| null | Public id of that principal — the key's own `key_…` when a key was used, else `user_…` |
| `status`                    | string         | Lifecycle status: `in_progress`, `requires_action`, `completed`, or `failed`                         |
| `started_at`                | string         | When the generation started                                                                          |
| `completed_at`              | string \| null | When the generation reached a terminal state                                                         |
| `last_activity_at`          | string \| null | Last activity timestamp                                                                              |
| `stop_reason`               | string \| null | Why the generation stopped — see [Stop Reason](./agents.md#stop-reason)                              |
| `error`                     | object \| null | Structured error payload recorded when the generation failed (see [Error Recording](#error-recording)) |
| `metadata`                  | object \| null | Caller-owned key/value annotations, returned verbatim (see [Metadata](#metadata))                    |
| `action_id`                 | string \| null | Logical action label supplied on the generate request                                                |
| `trigger_id`                | string \| null | Trigger that initiated the generation                                                                |
| `orchestration_run_id`      | string \| null | Orchestration run that dispatched the generation                                                     |
| `node_id`                   | string \| null | Node within that run                                                                                 |
| `node_attempt`              | number \| null | The node's 1-based retry attempt, so a retried node's generations are told apart (see [Finding an orchestration run's generations](#finding-an-orchestration-runs-generations)) |
| `agent_version`             | number \| null | Agent config version that served the generation                                                      |
| `source`                    | string \| null | `eval` when an [eval run](./evaluations.md) produced this generation; `null` for ordinary traffic     |
| `routing`                   | object \| null | What the [model route](./model-routes.md) did for this generation                                     |
| `extraction`                | object \| null | Memory-extraction summary for this turn (see [`extraction`](#extraction--memory-extraction-summary))  |
| `content_redacted_at`       | string \| null | When the generation's content was purged; `null` while content is intact                             |
| `content_redacted_by_principal_type` | string \| null | Principal kind that purged the content (`user` or `api_key`)                                |
| `content_redacted_by_principal_id` | string \| null | Public ID of that principal — the key's own id for API-key auth                               |
| `created_at`                | string         | ISO 8601 creation timestamp                                                                          |
| `updated_at`                | string         | ISO 8601 last-update timestamp                                                                       |

## Key Concepts

### Starting principal

`started_by_principal_type` / `started_by_principal_id` record who started the generation.
An API-key request records the **key itself** (`key_…`), so the generation names which key
acted rather than only the owning user; a JWT-authenticated request records the user
(`user_…`).

The pair is durable identity: work that resumes after the original request is gone
re-mints a short-lived credential from it. That lets an
[approval continuation](./approvals.md#continuation-identity), possibly days later,
authenticate its `builtin` tools as the principal that started the chain, and it is why a
generation started by a request-less drive (a [workflow dispatch](./workflows.md), an
[orchestration node](./orchestrations.md#durable-background-execution)) records the
drive's principal.

Both fields are `null` when the chain has no re-mintable principal: a generation started
by a [trigger](./triggers.md) or an [OAuth](./oauth.md) token. Each carries its authority
in the token (the trigger's attached policy, the consented scope), so recording a
principal would let a later re-mint act with the whole of the owning user's access.

### Lifecycle

A generation starts as `in_progress`. It transitions to:

- `requires_action` when a client tool call pauses the run and the caller must submit tool outputs.
- `completed` when the model finishes (the `stop_reason` carries the finish reason).
- `failed` when the run errors, for example when the upstream AI provider returns an error or is unreachable. `stop_reason` is set to `error` and the `error` field carries the failure details.

### Error Recording

When a generation fails, the failure is persisted on both the generation record and its trace: `status` becomes `failed`, `stop_reason` is `error`, and `error` carries `{ code, message }`.

`error` always contains `message`. `code` is set for mapped errors, most notably `AI_PROVIDER_ERROR`: the upstream AI provider returned an error (e.g. exhausted credits, rate limit) or is unreachable.

### Provider Error Surfacing (`AI_PROVIDER_ERROR`)

Generation endpoints return HTTP `502` with the `AI_PROVIDER_ERROR` code when the upstream AI provider fails:

```json
{
  "error": {
    "code": "AI_PROVIDER_ERROR",
    "message": "Provider returned 402: insufficient credits",
    "meta": {
      "provider_status_code": 402,
      "generation_id": "gen_abc123",
      "trace_id": "trace_xyz789"
    }
  }
}
```

`meta` carries the `generation_id` and `trace_id` of the failed run for inspection via [`GET /generations/:generation_id`](/docs/api/generations/get-generation) and [`GET /traces/:trace_id`](/docs/api/traces/get-trace).

### Metadata

`metadata` is a **caller-owned** bag, returned verbatim, for per-run audit attribution (e.g. which knowledge-corpus version produced an AI action).

- **At create time** — pass a `metadata` object on [`POST /agents/:id/generate`](/docs/api/agents/create-agent-generation).
- **After creation** — [`PATCH /generations/:generation_id`](/docs/api/generations/update-generation) with a `metadata` object. Keys are **shallow-merged** over the existing metadata, so repeated patches accumulate.

PATCH requires `generations:UpdateGeneration`; the create path requires `agents:CreateAgentGeneration`.

**No key is reserved.** Every piece of server-owned state (`action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version`, `routing`, `extraction`) is a field of its own, so nothing written into `metadata` can reach it; a caller key spelled `action_id` is just an annotation.

Internal recovery state (used to resume a `requires_action` generation after a server restart) is stored in its own column and is never exposed through the API.

#### `extraction` — memory-extraction summary

When an agent is configured with `knowledge_config.extraction` and `write_memory_id`, a completed generation writes an `extraction` summary — `{ "candidates": 3, "created": 2, "updated": 1, "skipped": 0 }` — describing what the auto-extraction pass did with the turn. See [Memories — Automatic Extraction](./memories.md#automatic-extraction).

### Recorded input

A generation also stores the messages it was asked to answer, resolved (file and document
references inlined) but without the agent's own instructions or knowledge injections,
which are config recoverable from `agent_version`.

The record is served by [the transcript](#transcript), not the generation response, and
exists so a real turn can be promoted into an evaluation fixture with
[`create-dataset-item-from-generation`](./evaluations.md#curating-items-from-production).
It is **content**, not skeleton: never written under zero-retention, cleared by a purge,
swept by retention. A generation whose input is gone can no longer be curated and answers
`409 GENERATION_CONTENT_UNAVAILABLE`.

### Transcript

[`GET /generations/{generation_id}/transcript`](/docs/api/generations/get-generation-transcript) reads one turn back step by step: what it
was asked, each model step with its tool calls and results, and how it ended.

```bash
soat get-generation-transcript --generation_id gen_abc
```

The transcript is **assembled at read time** from the generation record and the trace's
steps object; there is no transcript table and no extra write on the generation path, so
it always reflects the current records.

Requires `traces:GetTrace` in addition to `generations:GetGeneration`, since the response
merges content from both resources.

Each entry in `steps` carries `index`, `text`, `finish_reason`, `tool_calls`,
`tool_results` and `usage`. `args` on a call and `result` on a result are tool-owned
payloads, passed through exactly as recorded.

The stored steps are **projected**, never forwarded; their on-disk shape belongs to the
`ai` package.

Two states return `200` with a skeleton rather than an error, so a caller never has to
distinguish "no content" from "no such generation":

| State | `status` | `input` / `output` | `steps` | `content_redacted_at` |
|---|---|---|---|---|
| Still running | `in_progress` | `null` | `[]` | `null` |
| Never stored (zero-retention) | terminal | `null` | `[]` | set, principal `zero_retention` |
| Erased by a purge or sweep | terminal | `null` | `[]` | set, purging principal |

`step_count` survives all three, being a counter rather than content. It counts **this
turn's** steps: when a `trace_id` groups several generations, the trace's own `step_count`
covers every one of them, while each transcript reports only its own slice — see
[Traces → Grouping Generations Under One Trace](./traces.md#grouping-generations-under-one-trace).

A purged generation returns the skeleton even though the trace's steps object may still
exist (see the warning under [Content Purge](#content-purge)); the redaction marker
governs the whole transcript.

### Content Purge

[`DELETE /generations/{generation_id}/content`](/docs/api/generations/purge-generation-content) clears the generation's content — `metadata`, `error`, `extraction`, the recorded input messages, and the internal recovery state of a paused run — and stamps `content_redacted_at`. It requires the `generations:PurgeGenerationContent` action.

The usage and audit skeleton is preserved (the billing ledger outlives the erasure): ids, timestamps, status, stop reason, and every attribution field (`action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `node_attempt`, `agent_version`, `routing`). A purged generation reads back as that skeleton, not a 404.

The operation is idempotent: a second purge succeeds and leaves the original `content_redacted_at` untouched.

:::warning
A generation purge does **not** delete the parent trace's steps object, which holds this generation's content alongside its siblings'. To erase a run's content completely, purge the trace — [`DELETE /traces/{trace_id}/content`](/docs/api/traces/purge-trace-content) deletes the steps bytes from storage and cascades the content purge to every generation in the tree. See [Traces](./traces.md#content-purge).
:::

### Automatic content lifecycle

Two project settings turn the manual purge into a policy:

- **[Retention](./traces.md#retention-policy)** — `trace_content_retention_days` on the project runs a daily sweep that purges content past the window, through this same purge path.
- **[Zero-retention](./traces.md#zero-retention-mode)** — `trace_content_mode: "none"` on the project or the agent means the content columns are never written. The generation is still created and metered; it reads back as a skeleton stamped `content_redacted_by_principal_id: "zero_retention"` from the moment it exists.

### Sub-agent invocations

`initiator_generation_id` is populated only when an agent calls another agent via a builtin tool: the child generation records the calling generation's ID; top-level generations leave it `null`.

Intermediate steps of multi-step reasoning composed by the calling application are ordinary generations of their own, not `metadata` on or children of the calling generation.

### Finding an orchestration run's generations

An [orchestration](./orchestrations.md) run's `node_executions` record what each node received and produced but carry **no generation id**. The pointer runs the other way: a generation dispatched by an agent node stores `orchestration_run_id`, `node_id` and `node_attempt` as attribution columns, next to `action_id` and `trigger_id`. Filter the list endpoint:

```bash
# every generation the run produced
soat list-generations --orchestration-run-id run_abc123

# just one node's — one row per attempt if the node was retried
soat list-generations --orchestration-run-id run_abc123 --node-id summarize
```

`node_attempt` distinguishes the generations of a **retried** node: one node execution record and one generation per attempt, matched exactly on `node_attempt`.

From a generation reached this way, the rest of the graph is reachable: `trace_id` opens the [trace](./traces.md) for that turn, `initiator_generation_id` walks down into any [sub-agent invocations](#sub-agent-invocations) it made, `chain_id` opens the [continuation chain](./chains.md) it belongs to (filtering generations by that id returns every member), and `session_id` / `actor_id` name the [session](./sessions.md) and end user it ran for, the same pair its usage event is attributed to.

`session_id` and `actor_id` also **filter** the listing, so the turns behind a conversation's or an end user's [cost](./usage.md#end-user-attribution) are one call away:

```bash
soat list-generations --session-id sess_abc123
soat list-generations --actor-id actor_abc123
```

An id naming nothing in scope yields an empty page, never an unfiltered one.

### Tool context

The generation-creation endpoints ([`POST /agents/{agent_id}/generate`](/docs/api/agents/create-agent-generation), and the session and conversation generate endpoints) accept an optional `tool_context` object. Its entries are forwarded as `X-Soat-Context-*` request headers on every `http`, `mcp` and `builtin` tool call the generation makes; an invalid key is rejected with `400 INVALID_TOOL_CONTEXT_KEY` before the provider is called. It is not persisted on the Generation record. See the [Tool Context reference](../advanced/tool-context.md).

## Examples

### List generations

Filter by `agent_id`, `trace_id`, `initiator_generation_id`, `chain_id`, `orchestration_run_id`, `node_id`, or `status`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-generations --trace-id trace_abc123 --status failed
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.generations.listGenerations({
  query: { trace_id: 'trace_abc123', status: 'failed' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/generations?trace_id=trace_abc123&status=failed" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Get a generation

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-generation --generation-id gen_abc123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.generations.getGeneration({
  path: { generation_id: 'gen_abc123' },
});
if (error) throw new Error(JSON.stringify(error));
// data.status is "in_progress", "requires_action", "completed", or "failed"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/generations/gen_abc123 \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Attach audit metadata

Merge caller-supplied metadata onto a generation for per-run audit attribution.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-generation --generation-id gen_abc123 \
  --metadata '{"team":"payments","ticket_id":"OPS-4821"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.generations.updateGeneration({
  path: { generation_id: 'gen_abc123' },
  body: { metadata: { team: 'payments', ticket_id: 'OPS-4821' } },
});
if (error) throw new Error(JSON.stringify(error));
// data.metadata.ticket_id === "OPS-4821"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/generations/gen_abc123 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"team":"payments","ticket_id":"OPS-4821"}}'
```

</TabItem>
</Tabs>
