---
description: "Generation records track individual LLM runs started by agents, including lifecycle status and failure details."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Generations

Generation records track individual LLM generation runs started by agents, including their lifecycle status and any failure details.

## Overview

Every agent generation ([`POST /agents/:id/generate`](/docs/api/agents/create-agent-generation), session generation, sub-agent calls) creates a generation record before the model is called. The record tracks the run through its lifecycle and — when the run fails — stores a structured error payload so failed generations are distinguishable from pending ones and can be debugged post-mortem.

Generations can be listed via [`GET /generations`](/docs/api/generations/list-generations) (filter by `agent_id`, `trace_id`, or `status`), and each record can be retrieved via [`GET /generations/:generation_id`](/docs/api/generations/get-generation).

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
| `started_by_principal_type` | string \| null | Principal kind that started the generation — `user` or `api_key` (see [Starting principal](#starting-principal)) |
| `started_by_principal_id`   | string \| null | Public id of that principal — the key's own `key_…` when a key was used, else `user_…` |
| `status`                    | string         | Lifecycle status: `in_progress`, `requires_action`, `completed`, or `failed`                         |
| `started_at`                | string         | When the generation started                                                                          |
| `completed_at`              | string \| null | When the generation reached a terminal state                                                         |
| `last_activity_at`          | string \| null | Last activity timestamp                                                                              |
| `stop_reason`               | string \| null | Why the generation stopped (e.g. `stop`, `error`, `depth_guard`)                                     |
| `error`                     | object \| null | Structured error payload recorded when the generation failed (see [Error Recording](#error-recording)) |
| `metadata`                  | object \| null | Caller-owned key/value annotations, returned verbatim (see [Metadata](#metadata))                    |
| `action_id`                 | string \| null | Logical action label supplied on the generate request                                                |
| `trigger_id`                | string \| null | Trigger that initiated the generation                                                                |
| `orchestration_run_id`      | string \| null | Orchestration run that dispatched the generation                                                     |
| `node_id`                   | string \| null | Node within that run                                                                                 |
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

Every generation records who started it in `started_by_principal_type` /
`started_by_principal_id`. When the request was authenticated with an API key the
principal is the **key itself** (`key_…`), so a generation names which key acted
rather than only the user that owns it; a JWT-authenticated request records the
user (`user_…`).

The pair is durable identity, not a log line: work that resumes after the
original request is gone re-mints a short-lived credential from it. That is what
lets an [approval continuation](./approvals.md#continuation-identity) — possibly
days later — authenticate its `soat` tools as the principal that started the
chain, and it is why a generation started by a request-less drive (a
[workflow dispatch](./workflows.md), an
[orchestration node](./orchestrations.md#durable-background-execution)) records
the drive's principal rather than nothing.

Both fields are `null` when the chain has no re-mintable principal — a
generation started by a [trigger](./triggers.md) or an
[OAuth](./oauth.md) token. Each of those carries its authority in the token (the
trigger's attached policy, the consented scope) rather than in the principal, so
recording one would let a later re-mint drop that boundary and act with the whole
of the owning user's access.

### Lifecycle

A generation starts as `in_progress`. It transitions to:

- `requires_action` when a client tool call pauses the run and the caller must submit tool outputs.
- `completed` when the model finishes (the `stop_reason` carries the finish reason).
- `failed` when the run errors — for example when the upstream AI provider returns an error or is unreachable. `stop_reason` is set to `error` and the `error` field carries the failure details.

### Error Recording

When a generation fails, the failure is persisted on both the generation record and its trace: `status` becomes `failed`, `stop_reason` is `error`, and `error` carries `{ code, message }`.

The `error` object always contains `message`. `code` is set for mapped errors — most notably `AI_PROVIDER_ERROR`, which is used when the upstream AI provider returns an error (e.g. exhausted credits, rate limit) or is unreachable.

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

The `meta` field includes the `generation_id` and `trace_id` of the failed run so the failure can be inspected post-mortem via [`GET /generations/:generation_id`](/docs/api/generations/get-generation) and [`GET /traces/:trace_id`](/docs/api/traces/get-trace).

### Metadata

The `metadata` field is a **caller-owned** bag: it holds only what the caller put there, and it is returned verbatim. It is a place to attach per-run audit attribution — for example, which knowledge-corpus version produced an AI action.

Callers can write metadata two ways:

- **At create time** — pass a `metadata` object on [`POST /agents/:id/generate`](/docs/api/agents/create-agent-generation).
- **After creation** — [`PATCH /generations/:generation_id`](/docs/api/generations/update-generation) with a `metadata` object. The provided keys are **shallow-merged** over the existing metadata, so repeated patches accumulate.

Both paths require the `generations:UpdateGeneration` action for PATCH and `agents:CreateAgentGeneration` for the create path.

**No key is reserved.** Every piece of state the server owns (`action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version`, `routing`, `extraction`) is a field of its own on the generation, so nothing written into `metadata` can reach it. A caller key that happens to be spelled `action_id` is just an annotation; it does not affect the `action_id` field.

Internal recovery state (used to resume a `requires_action` generation after a server restart) is stored in its own column and is never exposed through the API under any name.

#### `extraction` — memory-extraction summary

When an agent is configured with `knowledge_config.extraction` and `write_memory_id`, a completed generation writes an `extraction` summary — `{ "candidates": 3, "created": 2, "updated": 1, "skipped": 0 }` — describing what the auto-extraction pass did with the turn. See [Memories — Automatic Extraction](./memories.md#automatic-extraction) for how it is configured.

### Recorded input

A generation also stores the messages it was asked to answer, resolved (file and document
references already inlined) but without the agent's own instructions or knowledge
injections — those are config, recoverable from `agent_version`.

The record is not part of the generation response; it is served by
[the transcript](#transcript) and it exists so a real turn can be promoted into
an evaluation fixture with
[`create-dataset-item-from-generation`](./evaluations.md#curating-items-from-production).
It is **content**, not skeleton, so it follows the same rules as everything below: never
written under zero-retention, cleared by a purge, and swept by retention. A generation
whose input is gone can no longer be curated, and says so with
`409 GENERATION_CONTENT_UNAVAILABLE`.

### Transcript

[`GET /generations/{generation_id}/transcript`](/docs/api/generations/get-generation-transcript) reads one turn back step by step: what it
was asked, each model step with its tool calls and results, and how it ended.

```bash
soat get-generation-transcript --generation_id gen_abc
```

The transcript is **assembled at read time** from the generation record and the trace's
steps object. There is no transcript table and no extra write on the generation path, so
it always reflects the current records and can never outlive the content it projects.

Requires `traces:GetTrace` in addition to `generations:GetGeneration`: the response merges
content from both resources, so a single generations action would silently widen to cover
trace content.

Each entry in `steps` carries `index`, `text`, `finish_reason`, `tool_calls`,
`tool_results` and `usage`. `args` on a call and `result` on a result are tool-owned
payloads, returned as values — their keys are passed through exactly as recorded and are
never inspected or rewritten.

The stored steps are **projected**, never forwarded: their on-disk shape belongs to the
`ai` package and changes with it, so putting it on the wire would freeze an internal
detail of a dependency as a public contract.

Two states return `200` with a skeleton rather than an error, so a caller never has to
distinguish "no content" from "no such generation":

| State | `status` | `input` / `output` | `steps` | `content_redacted_at` |
|---|---|---|---|---|
| Still running | `in_progress` | `null` | `[]` | `null` |
| Never stored (zero-retention) | terminal | `null` | `[]` | set, principal `zero_retention` |
| Erased by a purge or sweep | terminal | `null` | `[]` | set, purging principal |

`step_count` survives all three, because it is a counter rather than content. It counts
**this turn's** steps: when a `trace_id` groups several generations, the trace's own
`step_count` covers every one of them, while each transcript reports and projects only its
own slice — see [Traces → Grouping Generations Under One Trace](./traces.md#grouping-generations-under-one-trace).

A purged generation returns the skeleton even though the trace's steps object may still
exist — see the warning under [Content Purge](#content-purge). The redaction marker
governs the whole transcript, so an erased turn is never reconstituted from an adjacent
record.

### Content Purge

[`DELETE /generations/{generation_id}/content`](/docs/api/generations/purge-generation-content) clears the generation's content — `metadata`, `error`, `extraction`, the recorded input messages, and the internal recovery state of a paused run — and stamps `content_redacted_at`. It requires the `generations:PurgeGenerationContent` action.

The usage and audit skeleton is preserved on purpose: ids, timestamps, status, stop reason, and every attribution field (`action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version`, `routing`). A billing ledger has to outlive a tenant's erasure of the content, so a purged generation reads back as that skeleton rather than as a 404.

The operation is idempotent: a second purge succeeds and leaves the original `content_redacted_at` untouched.

:::warning
A generation purge does **not** delete the parent trace's steps object, which holds this generation's content alongside its siblings'. To erase a run's content completely, purge the trace — [`DELETE /traces/{trace_id}/content`](/docs/api/traces/purge-trace-content) deletes the steps bytes from storage and cascades the content purge to every generation in the tree. See [Traces](./traces.md#content-purge).
:::

### Automatic content lifecycle

Two project settings turn the manual purge into a policy:

- **[Retention](./traces.md#retention-policy)** — `trace_content_retention_days` on the project runs a daily sweep that purges content past the window, through this same purge path.
- **[Zero-retention](./traces.md#zero-retention-mode)** — `trace_content_mode: "none"` on the project or the agent means the content columns above are never written at all. The generation is still created and still metered; it simply reads back as a skeleton stamped `content_redacted_by_principal_id: "zero_retention"` from the moment it exists.

### Sub-agent invocations

`initiator_generation_id` is populated only when an agent calls another agent via a SOAT tool: the child generation records the calling generation's ID, while top-level generations leave it `null`. This is the sole case in which the field is set.

Multi-step reasoning is composed by the calling application, so intermediate steps appear as ordinary generations of their own rather than as `metadata` on, or child generations of, the calling generation.

### Tool context

The generation-creation endpoints ([`POST /agents/{agent_id}/generate`](/docs/api/agents/create-agent-generation), and the session and conversation generate endpoints) accept an optional `tool_context` object. Its entries are forwarded as `X-Soat-Context-*` request headers on every `http`, `mcp` and `soat` tool call the generation makes, and an invalid key is rejected with `400 INVALID_TOOL_CONTEXT_KEY` before the provider is called. It is not persisted on the Generation record. See the [Tool Context reference](../advanced/tool-context.md).

## Examples

### List generations

Filter by `agent_id`, `trace_id`, `initiator_generation_id`, or `status`.

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
