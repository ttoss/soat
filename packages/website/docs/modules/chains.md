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

Chains are how work outlives its request: an [approval](./approvals.md) decided days later resumes the proposing turn as a new generation, linked back; that resumption can propose another gated call, and so on. The chain is the whole tree.

This module is the record of that tree: size, liveness, why it stopped. **Read-only**, written by the continuation path, and created **lazily by the first continuation**, so a generation that never continues another has no record.

How a resumption is linked and bounded: [Continuation chains](./agents.md#continuation-chains). A chain is **not** a [trace tree](./traces.md#trace-ancestry-model), which runs inward through one turn's calls; a chain runs forward in time through resumed turns.

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

`agent_id` is the agent that *opened* the chain, not an owner; a chain can span agents. It is a plain id, so deleting the agent leaves the record intact.

There is no `root_generation_id` on the wire; the root is the internal key. Every member generation, root included, carries `chain_id`, so filtering generations by it returns exactly `generation_count` rows.

## Key Concepts

### Status

| Status | Meaning |
| --- | --- |
| `active` | Hops are still being spawned |
| `concluded` | A member finished with nothing left pending |
| `expired` | A held approval lapsed and nothing resumed the chain |
| `budget_exhausted` | A resumption was refused by the chain budget |

`concluded` is **not terminal**: an approval resolved months later spawns another hop and the chain returns to `active`. The status answers *which chains might still be spending?*

`expired` differs from `concluded` because a deadline, not a choice, stopped it. See [Approval Expiry](./agents.md#approval-expiry).

### Status is observability, not a gate

The budget is enforced by counting member generations directly, never by reading this record; a missing, stale, or wrong row cannot let a runaway through, and every write to it is best-effort. Use `status` and `generation_count` for triage, not enforcement.

### Bounding a chain

Each hop is a fresh turn with a fresh step budget, so `max_call_depth` (recursion *within* a request) never sees a chain. Three ceilings apply; the **smallest** wins:

| Ceiling | Set on | Scope |
| --- | --- | --- |
| `max_chain_generations` | the agent's [`stop_conditions`](./agents.md#stop-conditions) | one agent |
| `max_chain_generations` | the [project](./projects.md) | every chain in one project |
| `MAX_CONTINUATION_CHAIN_GENERATIONS` | the deployment's environment | every chain |

A narrower scope can be stricter than the one above, never looser, so the outer bound stays a backstop. Where two scopes name the same number, the **broader** one is reported as the source.

All three are read from *current* configuration at each hop, so lowering one stops a running chain.

On refusal: the chain moves to `budget_exhausted`, the refused turn is recorded on a [trace](./traces.md) with `stop_reason: "chain_limit"`, and a [`chain_limit` exception](./exceptions.md#producers) is filed against the root, naming which ceiling refused it.

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
  --stop-conditions '[{"type":"max_chain_generations","max_generations":20}]'

# Cap every chain in the project at 25, whatever its agents declare
soat update-project --project-id proj_01 --max-chain-generations 25
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
