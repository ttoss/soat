---
description: 'Embedding SOAT behind your own product: one project per tenant, one project-scoped API key per tenant, and no ownership tables of your own.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Building on SOAT

This page is for a **fronting service**: your own API, holding your own users, calling SOAT on their behalf. Your product's `/agents` endpoint proxies to SOAT's, and every request has to land inside exactly one customer's data.

The whole pattern is one sentence:

> **One project per tenant, one project-scoped API key per tenant, and never send a `project_id`.**

Everything below is why that is enough, and what you get to delete once you adopt it.

## The failure mode this replaces

The obvious first implementation is a single admin key, stored once in your environment, used for every tenant. It works on day one, and then it forces a second database on you.

Because that credential can reach every project, SOAT's answer to "which tenant owns agent `agent_XYZ`?" is no longer trustworthy at your boundary — not because SOAT doesn't know, but because the credential you asked with was allowed to see all of them. So the fronting service starts mirroring: an `Agent` table holding `(soat_id, project_id)`, then the same for tools, sessions, and providers, then a hand-rolled cascade delete to keep the mirrors from rotting. Each read becomes: look up ownership locally, then call SOAT, then hope the two agree.

Those tables exist to answer a question the platform already answers. Every SOAT resource carries a `project_id`, and the [IAM engine](../modules/iam.md) evaluates it on every request — the checks are simply unreachable through an unconfined credential.

## What a scoped credential guarantees

Mint the key with `project_id` set (see [Project Scoping](../modules/api-keys.md#project-scoping)) and the binding is a **hard boundary**, enforced ahead of — and independently of — the owner's role. An admin-owned key is confined exactly like a regular one.

| Your call, made with the `proj_tenant_a` key | What SOAT does |
| --- | --- |
| `GET /agents` (no `project_id`) | Returns tenant A's agents. There is no query that widens it |
| `GET /agents/{id}` for a tenant B agent | `404 RESOURCE_NOT_FOUND` — existence is not leaked |
| `POST /agents` (no `project_id`) | Creates in tenant A — the [implicit project id](../modules/api-keys.md#implicit-project-id) |
| Any call with `project_id=proj_tenant_b` | `403 API_KEY_PROJECT_SCOPE`, naming both projects |
| `POST /api-keys` for another project, or unscoped | `403` — the credential [cannot mint its way out](../modules/api-keys.md#the-boundary-covers-key-management-itself) |

That last row is what makes the rest load-bearing. Key creation is self-service, so without it a confined credential could mint an unscoped key for its owning user and be outside its boundary in a single call.

Two consequences worth internalizing:

- **Omitting `project_id` is the correct call, not a shortcut.** The credential names the project, so your proxy handler forwards the client's body as-is. A `project_id` arriving from your own client is something to *reject*, not to pass through.
- **A leaked tenant key leaks one tenant.** Blast radius is a property of the credential, not of your routing code.

## Provisioning a tenant

Three admin-side calls, once per tenant. Do them from your control plane with an admin credential — not with a tenant key, which by design cannot create projects it would then be unable to enter.

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

The `resource: ["*"]` above is not a hole: the key's project binding already confines it, and the policy's job here is to cap *which actions* the fronting layer may perform — trim the action list to what your product actually exposes. Store the raw `sk_` value in your own secret store; SOAT returns it exactly once.

One policy can be shared by every tenant key. It is the project binding that separates them, so you do not need a policy per tenant.

## Serving a request

Your route handler resolves the tenant, loads that tenant's key, and proxies. It does not consult a local ownership table, and it does not add a `project_id`.

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

Cache the client per tenant if you like; it holds no state beyond the base URL and token.

## Deprovisioning

Deleting the project is the cascade. `force=true` removes the project's dependent resources with it, so there is no ordering for you to encode:

```bash
soat delete-api-key --api_key_id key_V1StGXR8Z5jdHi6B
soat delete-project --project_id proj_V1StGXR8Z5jdHi6B --force true
```

Delete the key first if the tenant offboarding can be interrupted: a revoked key stops authenticating immediately, which makes a partially-deleted tenant unreachable rather than half-open.

## Which credential does what

| Credential | Held by | Can |
| --- | --- | --- |
| Admin JWT | Your control plane | Create/delete projects, policies, and users; mint keys for any project |
| Unscoped API key | Your control plane, for automation | Anything its owner's policies allow, across projects — **not** a tenant credential |
| Project-scoped API key | Your request path, one per tenant | Everything inside one project; nothing outside it, including minting its way out |

Keep the first two out of the request path entirely. A request-path credential that can name a project is a request-path credential that can name the *wrong* project.

## What you no longer need

- **Ownership mirror tables.** `project_id` on the SOAT resource is the answer, and the scoped key makes it enforceable rather than advisory.
- **Ownership checks before each call.** A foreign id is a `404` from SOAT; a foreign `project_id` is a `403`.
- **A hand-rolled cascade delete.** `delete-project --force true` covers dependents.
- **Reconciliation jobs.** There is only one copy of the ownership fact.

What you keep is the mapping SOAT genuinely cannot know: *your* tenant id → the SOAT project id and credential. That is one table, one row per tenant.

## Operational notes

- **Attribution.** Requests are attributed to the acting key, so the [audit log](../modules/audit-log.md) and [traces](../modules/traces.md) name which tenant credential acted — not just the owning user.
- **Rotation.** There is no rotation endpoint: mint a replacement and delete the old key. A tenant key can do this for its own project, so rotation does not need an admin credential in the request path.
- **Per-tenant limits.** [Quotas](../modules/quotas.md) can be scoped to a project or to an API key, which gives you per-tenant spend caps without any accounting of your own.
- **End users inside a tenant.** Model your customer's own users as [actors](../modules/actors.md), not as more projects. A project is a tenant boundary; an actor is a person inside one.
- **User-consented access instead of a stored key.** If your integration acts on behalf of a SOAT user who authorizes it — rather than on behalf of your own tenant — use [OAuth](../modules/oauth.md); its project-scoped tokens are confined by the same boundary.
