---
description: 'The permission model in one page: grant and cap, who a request runs as, what deferred work runs under, run_as, stored authority and IAM tokens.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# The Permission Model

One evaluator decides every request, whatever made it: a person, an API key, an agent, a trigger, a task, a tool server calling back. This page is the canonical statement of how authority is formed, stored and narrowed. Module pages keep their own specifics and link here.

Policy syntax, SRNs and conditions: [IAM](../modules/iam.md). Action strings: [Permissions Reference](../permissions.md).

## Grant and cap

A request's authority is its **grant** ∩ every **cap**, inside the project its credential is pinned to.

| Term  | Is                                                                                          | Absent                   |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------ |
| Grant | The user's policies; a trigger's `policy_ids` for its firing; an agent's under `run_as: agent` | Allows nothing           |
| Cap   | A key's `policy_ids`, an OAuth scope, an IAM token's bound, an `On-Behalf-Of` assertion     | Narrows nothing          |

A cap never adds: an `Allow` beyond the grant grants nothing. Default deny, an explicit `Deny` wins ([Policy Evaluation](../modules/iam.md#policy-evaluation)). Every grant and cap is read at each request, so editing a policy or deleting a key takes effect on work already running.

## Who a request runs as

| Credential                  | Grant                                | Caps                                            |
| --------------------------- | ------------------------------------ | ----------------------------------------------- |
| Login (JWT)                 | The user's policies; `admin` is unrestricted | None                                     |
| API key                     | Its owner's policies                 | The key's `policy_ids`; pinned to its `project_id` |
| OAuth token                 | Its user's policies                  | The consented scope; pinned to its project      |
| [IAM token](#iam-tokens)    | Its issuing key's                    | The token's bound ∩ the key's `policy_ids`      |

Only a credential with no project and no `policy_ids` held by an `admin` is unrestricted. Details: [Authorization Model](../modules/iam.md#authorization-model), [API Keys](../modules/api-keys.md#permission-inheritance).

Ask the engine what the calling credential may do with [`POST /api/v1/iam/check`](/docs/api/iam/check-iam-permission):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat check-iam-permission \
  --action agents:CreateAgentGeneration \
  --resource srn:proj_V1StGXR8Z5jdHi6B:agent:agent_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.iam.checkIamPermission({
  body: {
    action: 'agents:CreateAgentGeneration',
    resource: 'srn:proj_V1StGXR8Z5jdHi6B:agent:agent_V1StGXR8Z5jdHi6B',
  },
});
if (error) throw new Error(JSON.stringify(error));
// data.allowed is true or false
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/iam/check \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "action": "agents:CreateAgentGeneration",
    "resource": "srn:proj_V1StGXR8Z5jdHi6B:agent:agent_V1StGXR8Z5jdHi6B"
  }'
```

</TabItem>
</Tabs>

## A resource that acts later

An agent, trigger, webhook, playbook version, decider, eval, ingestion rule or memory rule acts after the write that made it, when nobody is present. It carries its own authority, `policy_ids`, so it survives its writer and never borrows the writer's credential at run time.

| Resource            | Acts as                                         | Capped by whoever starts it            |
| ------------------- | ----------------------------------------------- | -------------------------------------- |
| Agent               | `run_as: caller` the caller; `run_as: agent` its `policy_ids` | `caller`: yes. `agent`: no |
| Trigger             | Its `policy_ids` for a firing nobody called     | A manual fire: the firer ∩ `policy_ids` |
| Playbook version    | Its `policy_ids` (`principal_type: playbook_version`) | No                              |
| Decider, eval       | Its `policy_ids`                                | Yes: the requester, the run's starter  |
| Ingestion rule      | Its `policy_ids`                                | Yes: whoever ingests                   |
| Memory rule         | Its `policy_ids` alone (`principal_type: memory_rule`) | No                              |
| Webhook             | Its `policy_ids` decide what a delivery may read | Not applicable                        |

### What its writer must hold

**A resource does no more than whoever writes it.** Every create and edit, through the API or a [formation](../modules/formations.md), is checked against the resource as the write leaves it, whichever fields the request names:

| The resource                    | The writer must hold                                          | Refusal                     |
| ------------------------------- | ------------------------------------------------------------- | --------------------------- |
| carries `policy_ids`            | every grant of each policy, inside the resource's project     | `403 POLICY_GRANT_NOT_HELD` |
| starts a target                 | the target's start action                                     | `403 ACTION_NOT_HELD`       |
| names a secret                  | `secrets:UseSecret` on it                                     | `403 FORBIDDEN`             |

A `builtin` tool may name only what the deployment's [builtin catalog](../modules/iam.md#the-builtin-catalog) offers: the native actions it allows, and the actions it adds. An added action holds its writer to the actions the deployment declares for it, and its server receives the call only with the signed assertion ([What a tool server receives](#what-a-tool-server-receives)).

Start actions: `agents:CreateAgentGeneration`, `tools:CallTool`, `deciders:CreateDecision`, `tasks:CreateTask`, `orchestrations:StartRun`, `evaluations:RunEval`. Editing a policy a resource carries is attaching it again, and deleting one it names is `409 POLICY_HAS_DEPENDENTS`. Full table: [The writer rule](../modules/iam.md#the-writer-rule).

An empty `policy_ids` allows nothing; a create without one is `400 VALIDATION_FAILED` where it is required.

## run_as

An agent's `run_as` states what its `policy_ids` are.

| `run_as`           | A turn runs as                                                     | The caller needs                                 |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------ |
| `caller` (default) | the caller, capped by `policy_ids`                                 | each permission the agent's calls perform        |
| `agent`            | `policy_ids` alone, inside the agent's project                     | `agents:CreateAgentGeneration` on the agent      |

`run_as: agent` needs a non-empty `policy_ids`, else `400 AGENT_RUN_AS_REQUIRES_POLICIES`. It lets an agent serve a caller that holds nothing else, such as an MCP client or a channel contact. The project's [`agent_policy_ids`](../modules/projects.md#project-agent-cap) cap every turn in both modes. Details: [Execution Identity](../modules/agents.md#execution-identity).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent \
  --name support-agent \
  --run-as agent \
  --policy-ids '["pol_V1StGXR8Z5jdHi6B"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.agents.createAgent({
  body: {
    name: 'support-agent',
    run_as: 'agent',
    policy_ids: ['pol_V1StGXR8Z5jdHi6B'],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/agents \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support-agent",
    "run_as": "agent",
    "policy_ids": ["pol_V1StGXR8Z5jdHi6B"]
  }'
```

</TabItem>
</Tabs>

## Stored authority

Work that outlives its request stores the authority it was started under: the starter's grant and every cap on it, or a trigger's `policy_ids` for a firing nobody called. It stores policy ids and caps, never a token, so it does not expire and is read at every call.

| Work                                                                  | Stores                                      | Every later drive runs under it                                  |
| --------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| [Generation](../modules/generations.md#starting-principal)            | The starter's, or the agent's under `run_as: agent` | Tool calls, `submit-tool-outputs` resumes                |
| [Approval continuation](../modules/approvals.md#continuation-identity) | The proposing generation's                 | The approved action and later approvals of the chain; never the approver's |
| [Task](../modules/workflows.md)                                       | That of whoever last moved it               | Dispatches; an `automation` hop carries the routing run's        |
| [Orchestration run](../modules/orchestrations.md#durable-background-execution) | The starter's                      | Every drive; `loop` and `sub_orchestration` children inherit it  |
| [Trigger firing](../modules/triggers.md#execution-identity)           | The trigger's `policy_ids`, or that ∩ the firer's | The run or generation it starts; a redelivery too          |

Rules that hold for all of it:

- **A resume only narrows.** Whoever resumes work holds the stored authority to their own: it can do only what both allow, and a wider resumer adds nothing. Under `run_as: agent` the agent's grant applies either way.
- **Revoking stops it.** Deleting the starting key, or removing its permission, refuses the work's next call. Deleting a trigger refuses every call of work under it (`403 FORBIDDEN`).
- **Fail closed.** Work that stores no authority, or whose authority names a user or API key that no longer exists, makes no call: `409 WORK_AUTHORITY_MISSING`, on every path (a tool call, an in-process API call, a firing, a playbook execution).
- **Attribution.** Records name the principal that acted (`key_…`, a trigger, a playbook version, a memory rule); [`acted_as`](../modules/generations.md#acting-principal) on a generation says whose authority its tool calls ran as.

## What the caller names

Authority formed from the stored grant covers what the agent does. What a caller supplies in the call itself is the caller's: a `document` or `tool_output` message (every action a `tool_output` reaches), a per-call `knowledge_config`, a `tool_context`. It is checked as the caller, capped by `policy_ids` under `run_as: caller`, so naming a resource never reaches it through the agent's wider grant.

## IAM tokens

An API key scoped to a project issues a short-lived token that acts as the key held to a narrower policy, for a caller the key serves on behalf of someone with less reach. [`POST /api/v1/iam/tokens`](/docs/api/iam/create-iam-token) needs `iam:CreateToken` and answers `201 { "token", "expires_at" }`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-iam-token \
  --policy '{"statement":[{"effect":"Allow","action":["agents:CreateAgentGeneration"]}]}' \
  --principal '{"type":"service","id":"billing-sync"}' \
  --ttl-seconds 300
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.iam.createIamToken({
  body: {
    policy: {
      statement: [
        { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
      ],
    },
    principal: { type: 'service', id: 'billing-sync' },
    ttl_seconds: 300,
  },
});
if (error) throw new Error(JSON.stringify(error));
// data.token, data.expires_at
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/iam/tokens \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "statement": [
        { "effect": "Allow", "action": ["agents:CreateAgentGeneration"] }
      ]
    },
    "principal": { "type": "service", "id": "billing-sync" },
    "ttl_seconds": 300
  }'
```

</TabItem>
</Tabs>

- The bound is `policy` (inline) or `policy_ids`, exactly one. Work the token starts keeps the bound after the token expires; `policy_ids` are re-read, an inline `policy` is a snapshot.
- `ttl_seconds` runs 30 to 900 (default 300).
- Only a project-scoped API key issues one; any other caller is `403 IAM_TOKEN_ISSUER_NOT_ALLOWED`.
- `principal` is opaque and grants nothing; the [audit log](../modules/audit-log.md) records it with the token's `jti`.

Full reference: [IAM Tokens](../modules/iam.md#iam-tokens).

## What a tool server receives

An `mcp` tool call, and a call of an action the deployment [adds to `builtin`](../modules/iam.md#the-builtin-catalog), carries a signed assertion in `X-Soat-Tool-Assertion`. It names the tool, project, agent, generation and durable work that made the call and the principal its chain of work acts for (`acts_for`), and carries the call's authority encrypted in `ath`: the receiver can read the identity claims and cannot read or alter the authority.

A tool server that writes back sends the assertion unchanged in `X-Soat-On-Behalf-Of`, with its project's API key or an IAM token that key issued. The request is then held to the key ∩ the authority the call was sent with ∩ the calling agent's `policy_ids` (and the generation's execution identity), and so is any work it starts. The assertion never widens: the principal stays the key.

An assertion that does not verify, names another project or carries no readable `ath` is `400 ON_BEHALF_OF_INVALID`; nothing is written. Details: [Tool Assertions](../modules/tools.md#tool-assertions), [Writing on behalf of a tool call](../modules/tools.md#writing-on-behalf-of-a-tool-call).

## What mints no key

A request narrowed beyond its credential's own grant creates no API key and consents to no OAuth client, because a key cannot carry the narrowing: an OAuth access token, an IAM token, an `On-Behalf-Of` assertion and every call durable work makes under its stored authority. [`POST /api/v1/api-keys`](/docs/api/api-keys/create-api-key), [`PUT /api/v1/api-keys/{id}`](/docs/api/api-keys/update-api-key) and an `api_key` formation resource answer `403 CREDENTIAL_NARROWED`. Reading, listing and deleting keys are unaffected. See [A project-scoped token writes no key](../modules/api-keys.md#a-project-scoped-token-writes-no-key).

## What an admission service may add

A deployment may register an [admission service](../modules/iam.md#admission) for runtime writes it gates for its own reasons. It is asked after authorization allowed the write, before it executes, on every way in: REST, a `builtin` tool call and a formation create or update. A start (a generation, a run, a manual fire) is asked once, where a caller starts it; the run's own steps and a scheduled firing are not asked again.

- It may refuse: the caller receives the service's own `4xx` status, `code`, `message` and `meta`.
- It may not allow: a write authorization refused is never asked about, and a service that does not answer refuses (`502 ADMISSION_UNAVAILABLE`).
- It sees the write (action, project, resource, body as applied) and the principal; it grants nothing and its answer is not a policy.

## Refusals

| Status and code                   | Means                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `403 FORBIDDEN`                   | The grant or a cap denies the action; `meta.denied_by` names which   |
| `403 POLICY_GRANT_NOT_HELD`       | A writer attaches a grant it does not hold; `meta.ungranted`         |
| `403 ACTION_NOT_HELD`             | A writer names a target or action it may not start                   |
| `403 CREDENTIAL_NARROWED`         | A narrowed request tried to create a key or consent to a client      |
| `403 IAM_TOKEN_ISSUER_NOT_ALLOWED`| The caller may not issue an IAM token                                |
| `400 AGENT_RUN_AS_REQUIRES_POLICIES` | `run_as: agent` without `policy_ids`                              |
| `400 ON_BEHALF_OF_INVALID`        | The assertion does not verify, names another project or has no `ath` |
| `409 WORK_AUTHORITY_MISSING`      | Durable work stores no authority, or one that no longer resolves     |
| `409 POLICY_HAS_DEPENDENTS`       | A policy a resource still names cannot be deleted                    |
| The service's `4xx` and `code`   | The admission service refused the write                              |
| `502 ADMISSION_UNAVAILABLE`       | The admission service asked about the write did not answer           |

The denial shape and the `403`/`404` split: [What a Denial Looks Like](../modules/iam.md#what-a-denial-looks-like).
