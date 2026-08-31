---
description: "Continuation chains — the linked tree of generations a resumed turn grows into, how large it has grown, and the ceilings that stop it."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chains

A continuation chain is the population of [generations](./generations.md) that
descend from one root because each declared the previous one as its
`initiator_generation_id`.

## Overview

Chains are how work outlives the request that started it. An
[approval](./approvals.md) decided three days later resumes the turn that
proposed the call — as a new generation, linked back. That resumption can propose
another gated call, approved later still, and so on; the chain is the whole tree
that grows out of the first turn.

This module is the record of that tree: how large it has grown, whether it is
still alive, and why it stopped. It is **read-only** — a chain is written by the
continuation path, never by a caller — and it is created **lazily by its first
continuation**, so a generation that never continues another is not a chain and
gets no record. The table holds runaway candidates, not one row per turn.

The behavior that produces a chain lives with the agent: see
[Continuation chains](./agents.md#continuation-chains) for how a resumption is
linked and bounded. A chain is **not** the same thing as a
[trace tree](./traces.md#trace-ancestry-model) — that one runs inward through the
calls a single turn makes, while a chain runs forward in time through turns
resumed after their request is gone; that section spells out the difference and
why the two are kept independent.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public ID, `chain_` prefix |
| `project_id` | string | Owning project |
| `agent_id` | string \| null | The agent whose continuation opened the chain |
| `status` | string | `active`, `concluded`, `expired`, `budget_exhausted` |
| `generation_count` | integer | Generations in the chain, the root included |
| `last_generation_at` | string \| null | When the chain last gained a generation |
| `created_at` | string | Creation timestamp |
| `updated_at` | string | Last update timestamp |

`agent_id` names the agent that *opened* the chain, not an owner — a chain can
span agents. It is held as a plain id rather than a maintained reference, so
deleting that agent leaves the chain's record, and the evidence of what it did,
intact.

There is no `root_generation_id` on the wire: the root is the chain's internal
key, and exposing it would create a second handle for the same thing. Every
generation in a chain carries `chain_id` instead — including the root — so
filtering generations by that id returns the chain's members, and
`generation_count` is exactly how many that filter returns.

## Key Concepts

### Status

| Status | Meaning |
| --- | --- |
| `active` | Hops are still being spawned |
| `concluded` | A member finished with nothing left pending |
| `expired` | A held approval lapsed and nothing resumed the chain |
| `budget_exhausted` | A resumption was refused by the chain budget |

`concluded` is **not terminal**. A chain is quiescent, not finished: an approval
resolved months from now spawns another hop and the chain returns to `active`.
The status answers the operator's actual question — *which chains might still be
spending?* — for which a value that could only ever be set once would be useless.

`expired` is distinguished from `concluded` because nothing *chose* to stop: a
deadline did. See [Approval Expiry](./agents.md#approval-expiry) for when an
expired approval ends a chain instead of reporting to the agent.

### Status is observability, not a gate

The budget is enforced by counting a chain's member generations directly, never
by reading this record. A chain row that is missing, stale, or wrong therefore
cannot let a runaway through — and every write to it is best-effort, because
failing a generation in order to record a status about it would trade the thing
that matters for the thing that describes it.

Trust `status` and `generation_count` for triage; do not build enforcement on
them.

### Bounding a chain

A chain is unbounded by construction — each hop is a fresh turn with a fresh step
budget, so `max_call_depth`, which bounds recursion *within* a request, never
sees it. Two ceilings apply, and the **smaller** wins:

| Ceiling | Set on | Scope |
| --- | --- | --- |
| `maxChainGenerations` | the agent's [`stop_conditions`](./agents.md#stop-conditions) | one agent |
| `MAX_CONTINUATION_CHAIN_GENERATIONS` | the deployment's environment | every chain |

An agent can be stricter than its deployment but never looser: the platform
ceiling stays a backstop, which is the one thing it cannot be if an agent could
raise it — the agent that runs away is precisely the one whose configuration is
wrong.

Both are read from the *current* configuration each time a hop is spawned, not
captured when the chain started, so lowering either can stop a chain that is
already running.

When a resumption is refused, three things happen: the chain moves to
`budget_exhausted`, the refused turn is recorded on a [trace](./traces.md) with
`stop_reason: "chain_limit"`, and a
[`chain_limit` exception](./exceptions.md#producers) is filed against the chain's
root. The exception is what actually reaches a human — a chain is usually resumed
by a background sweep with nobody waiting on the answer — and its `detail`
carries `limit` and `limit_source` (`agent` or `platform`), so the fix is
unambiguous: raise the agent's number, or raise the deployment's.

## Examples

<Tabs groupId="client">
<TabItem value="cli" label="CLI">

```bash
# Chains that may still be spending
soat list-chains --project-id proj_01 --status active

# Chains a budget stopped
soat list-chains --project-id proj_01 --status budget_exhausted

# One chain, then the generations in it
soat get-chain --chain-id chain_01
soat list-generations --chain-id chain_01

# Cap an agent's chains at 20 generations
soat update-agent --agent-id agent_01 \
  --stop-conditions '[{"type":"maxChainGenerations","max_generations":20}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: chains } = await client.GET('/api/v1/chains', {
  params: { query: { project_id: 'proj_01', status: 'active' } },
});

const { data: chain } = await client.GET('/api/v1/chains/{chain_id}', {
  params: { path: { chain_id: 'chain_01' } },
});

const { data: members } = await client.GET('/api/v1/generations', {
  params: { query: { chain_id: chain!.id } },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -H "Authorization: Bearer $SOAT_TOKEN" \
  "$SOAT_BASE_URL/api/v1/chains?project_id=proj_01&status=active"

curl -H "Authorization: Bearer $SOAT_TOKEN" \
  "$SOAT_BASE_URL/api/v1/chains/chain_01"

curl -H "Authorization: Bearer $SOAT_TOKEN" \
  "$SOAT_BASE_URL/api/v1/generations?chain_id=chain_01"
```

</TabItem>
</Tabs>
