---
description: 'Embedding SOAT behind your own product: one project per tenant, one project-scoped API key per tenant, and no ownership tables of your own.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Building on SOAT

For a **fronting service**: your own API, holding your own users, calling SOAT on their behalf. Every request has to land inside exactly one customer's data.

> **One project per tenant, one project-scoped API key per tenant, and never send a `project_id`.**

## The failure mode this replaces

A single admin key used for every tenant can reach every project, so SOAT's answer to "which tenant owns agent `agent_XYZ`?" is not trustworthy at your boundary. The fronting service then mirrors ownership — `(soat_id, project_id)` tables for agents, tools, sessions, providers — plus a hand-rolled cascade delete, and each read checks the mirror before calling SOAT.

Those tables answer a question the platform already answers: every SOAT resource carries a `project_id`, and the [IAM engine](../modules/iam.md) evaluates it on every request. The checks are simply unreachable through an unconfined credential.

## What a scoped credential guarantees

Mint the key with `project_id` set (see [Project Scoping](../modules/api-keys.md#project-scoping)). The binding is a hard boundary, enforced ahead of and independently of the owner's role; an admin-owned key is confined exactly like a regular one.

| Your call, made with the `proj_tenant_a` key | What SOAT does |
| --- | --- |
| [`GET /agents`](/docs/api/agents/list-agents) (no `project_id`) | Returns tenant A's agents. There is no query that widens it |
| [`GET /agents/{id}`](/docs/api/agents/get-agent) for a tenant B agent | `404 RESOURCE_NOT_FOUND` — existence is not leaked |
| [`POST /agents`](/docs/api/agents/create-agent) (no `project_id`) | Creates in tenant A — the [implicit project id](../modules/api-keys.md#implicit-project-id) |
| Any call with `project_id=proj_tenant_b` | `403 API_KEY_PROJECT_SCOPE`, naming both projects |
| [`POST /api-keys`](/docs/api/api-keys/create-api-key) for another project, or unscoped | `403` — the credential [cannot mint its way out](../modules/api-keys.md#the-boundary-covers-key-management-itself) |

The last row makes the rest load-bearing: key creation is self-service, so without it a confined credential could mint an unscoped key for its owning user in one call.

- **Omitting `project_id` is the correct call.** The credential names the project; forward the client's body as-is. A `project_id` arriving from your own client is something to reject.
- **A leaked tenant key leaks one tenant.** Blast radius is a property of the credential, not of your routing code.

## Provisioning a tenant

Three admin-side calls, once per tenant, from your control plane with an admin credential (a tenant key cannot create projects).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "tenant-acme" | jq -r '.id')

POLICY_ID=$(soat create-policy \
  --name "fronting-layer" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["agents:*", "tools:*", "sessions:*", "documents:*"],
        "resource": ["*"]
      }
    ]
  }' | jq -r '.id')

soat create-api-key \
  --name "tenant-acme" \
  --project_id "$PROJECT_ID" \
  --policy_ids "$POLICY_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';

const admin = new SoatClient({ baseUrl: SOAT_URL, token: ADMIN_TOKEN });

const { data: project } = await admin.projects.createProject({
  body: { name: `tenant-${tenant.slug}` },
});

const { data: key } = await admin.apiKeys.createApiKey({
  body: {
    name: `tenant-${tenant.slug}`,
    project_id: project!.id,
    policy_ids: [FRONTING_LAYER_POLICY_ID],
  },
});

// key.key is the raw `sk_` secret and is never returned again.
await saveTenantCredential({ tenantId: tenant.id, soatKey: key!.key });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "$SOAT_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tenant-acme",
    "project_id": "proj_V1StGXR8Z5jdHi6B",
    "policy_ids": ["pol_V1StGXR8Z5jdHi6B"]
  }'
```

</TabItem>
</Tabs>

`resource: ["*"]` is not a hole: the project binding confines the key; the policy caps *which actions* the fronting layer may perform — trim the action list to what your product exposes. Store the raw `sk_` value in your own secret store; SOAT returns it exactly once.

One policy can be shared by every tenant key; the project binding separates them.

## Serving a request

The route handler resolves the tenant, loads that tenant's key, and proxies. No local ownership table, no added `project_id`.

```ts
const soatFor = (tenantId: string) => {
  return new SoatClient({
    baseUrl: SOAT_URL,
    token: credentials.get(tenantId), // the tenant's sk_ key
  });
};

// GET /api/agents  — your product's route
export const listAgents = async (req, res) => {
  const { data, error } = await soatFor(req.tenant.id).agents.listAgents({});
  if (error) return res.status(error.status ?? 500).json(error);
  return res.json(data);
};

// GET /api/agents/:id — no ownership lookup; a foreign id is simply a 404
export const getAgent = async (req, res) => {
  const { data, error } = await soatFor(req.tenant.id).agents.getAgent({
    path: { agent_id: req.params.id },
  });
  if (error) return res.status(error.status ?? 500).json(error);
  return res.json(data);
};
```

The client holds no state beyond the base URL and token; cache it per tenant if you like.

## Deprovisioning

Deleting the project is the cascade; `force=true` removes dependent resources with it:

```bash
soat delete-api-key --api_key_id key_V1StGXR8Z5jdHi6B
soat delete-project --project_id proj_V1StGXR8Z5jdHi6B --force true
```

Delete the key first: a revoked key stops authenticating immediately, so an interrupted offboarding leaves the tenant unreachable rather than half-open.

## Which credential does what

| Credential | Held by | Can |
| --- | --- | --- |
| Admin JWT | Your control plane | Create/delete projects, policies, and users; mint keys for any project |
| Unscoped API key | Your control plane, for automation | Anything its owner's policies allow, across projects — **not** a tenant credential |
| Project-scoped API key | Your request path, one per tenant | Everything inside one project; nothing outside it, including minting its way out |

Keep the first two out of the request path: a request-path credential that can name a project can name the wrong project.

## What you no longer need

- **Ownership mirror tables.** `project_id` on the SOAT resource is the answer; the scoped key makes it enforceable.
- **Ownership checks before each call.** A foreign id is a `404`; a foreign `project_id` is a `403`.
- **A hand-rolled cascade delete.** `delete-project --force true` covers dependents.
- **Reconciliation jobs.** There is one copy of the ownership fact.

What you keep: *your* tenant id → the SOAT project id and credential. One table, one row per tenant.

## Operational notes

- **Attribution.** Requests are attributed to the acting key, so the [audit log](../modules/audit-log.md) and [traces](../modules/traces.md) name which tenant credential acted, not only the owning user.
- **Rotation.** No rotation endpoint: mint a replacement and delete the old key. A tenant key can do this for its own project, so no admin credential is needed in the request path.
- **Per-tenant limits.** [Quotas](../modules/quotas.md) scope to a project or an API key: per-tenant spend caps without accounting of your own.
- **End users inside a tenant.** Model your customer's own users as [actors](../modules/actors.md), not as more projects. A project is a tenant boundary; an actor is a person inside one.
- **User-consented access instead of a stored key.** If your integration acts on behalf of a SOAT user who authorizes it, use [OAuth](../modules/oauth.md); its project-scoped tokens are confined by the same boundary.
