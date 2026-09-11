---
description: "SOAT's AWS-inspired IAM engine for authentication and fine-grained authorization with Effect, Action, Resource, and Condition policy statements."
---

# IAM

Authentication, identity, and fine-grained authorization: an AWS IAM-inspired policy engine with `Effect`, `Action`, `Resource`, and `Condition` statements.

## Overview

Every request is authenticated via JWT (users) or an API key, and authorized entirely through attached **policy documents**; there is no separate project membership gate.

- **Users** — identity, roles, JWT ([Users](#users))
- **Policy Documents** — permission rules attached to users and API keys ([Policies](./policies.md))
- **Policy Engine** — allow/deny resolution at request time
- **Authorization Model** — policy resolution per caller type ([Authorization Model](#authorization-model))

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies)
- [Permissions in Practice - Step 6 (Create API keys)](/docs/tutorials/permissions#step-6--create-api-keys)
- [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions)

## Authentication

Two methods, both via `Authorization: Bearer <token>`.

### JWT (Users)

[`POST /api/v1/users/login`](/docs/api/users/login-user) with username and password returns a signed JWT carrying the user's public ID and role. Admins bypass policy evaluation; regular users are authorized by their attached [policies](./policies.md).

### API Keys

Keys are prefixed `sk_` with a `key_` public ID, always scoped to a single project via `project_id`, optionally with their own policies. With key policies, **intersection semantics** apply: the owning user's policies _and_ the key's must both allow the action, so a key never exceeds its owner. See [API Keys](./api-keys.md) and [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions).

## Policy Documents

A policy document is a JSON object of statements:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:ListDocuments"],
      "resource": ["srn:proj_ABC:document:doc_XYZ"]
    },
    {
      "effect": "Deny",
      "action": ["secrets:*"],
      "resource": ["srn:proj_ABC:secret:sec_PROD_KEY"]
    }
  ]
}
```

### Statement

| Field       | Type       | Required | Description                                             |
| ----------- | ---------- | -------- | ------------------------------------------------------- |
| `effect`    | `string`   | Yes      | `"Allow"` or `"Deny"`                                   |
| `action`    | `string[]` | Yes      | Actions this statement applies to (supports wildcards)  |
| `resource`  | `string[]` | No       | SRNs this statement applies to (default: `["*"]`)       |
| `condition` | `object`   | No       | Conditions that must be true for the statement to apply |

Documents are managed globally via [Policies](./policies.md) and attached to users or API keys. Worked example: [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies).

## SOAT Resource Names (SRNs)

Every addressable entity has an SRN:

```
srn:<project_id>:<resource_type>:<resource_id>
```

Examples:

| SRN                              | Description                |
| -------------------------------- | -------------------------- |
| `srn:proj_ABC:document:doc_XYZ` | A specific document        |
| `srn:proj_ABC:document:*`       | All documents in a project |
| `srn:proj_ABC:file:*`           | All files in a project     |
| `srn:proj_ABC:actor:actor_123`  | A specific actor           |
| `srn:*:*:*`                     | Everything (admin-level)   |

### Project Segment and Policy Scoping

Policies are **global**, so the `<project_id>` segment is the primary project restriction:

- `resource: ["*"]` — all resources in **all projects**
- `resource: ["srn:proj_ABC:*:*"]` — `proj_ABC` only
- `resource: ["srn:*:document:*"]` — all documents across all projects

:::tip
Grant a **user** (JWT) a project with `resource: ["srn:proj_ABC:*:*"]`. API keys are scoped via `project_id` (see [API Keys](./api-keys.md#project-scoping)).
:::

### Resource Types

| Resource Type  | Public ID Prefix | Module        |
| -------------- | ---------------- | ------------- |
| `document`     | `doc_`           | Documents     |
| `file`         | `file_`          | Files         |
| `actor`        | `actor_`         | Actors        |
| `conversation` | `conv_`          | Conversations |
| `project`      | `proj_`          | Projects      |
| `policy`       | `pol_`           | Policies      |
| `api-key`      | `key_`           | API Keys      |

## Actions

Actions follow `module:Operation`. Full list: [Permissions Reference](../permissions.md).

### Action Surface Mapping

Every action maps to one operation reachable through every client surface, e.g. `actors:CreateActor`:

| Surface           | Convention                    | Example                     |
| ----------------- | ----------------------------- | --------------------------- |
| **Permission**    | `module:OperationName`        | `actors:CreateActor`        |
| **REST endpoint** | `METHOD /api/v1/...`          | [`POST /api/v1/actors`](/docs/api/actors/create-actor)       |
| **MCP tool**      | kebab-case operation name     | `create-actor`              |
| **CLI command**   | `soat <kebab-case>`           | `soat create-actor`         |
| **SDK method**    | `soat.<module>.<camelCase>()` | `soat.actors.createActor()` |

A caller may invoke an operation iff the resolved policy grants the action, on any surface.

### Wildcards

- `*` — matches all actions across all modules
- `module:*` — matches all actions in a specific module (e.g., `documents:*`)

## Conditions

Conditions add attribute-based constraints: an operator mapped to key-value pairs that must all hold.

```json
{
  "condition": {
    "StringEquals": {
      "soat:ResourceTag/environment": "production"
    },
    "StringLike": {
      "soat:ResourceTag/team": "engineering-*"
    }
  }
}
```

### Condition Operators

| Operator          | Description                   |
| ----------------- | ----------------------------- |
| `StringEquals`    | Exact string match            |
| `StringNotEquals` | Negated exact match           |
| `StringLike`      | Glob pattern match (`*`, `?`) |

### Condition Keys

| Key                      | Source        | Description                             |
| ------------------------ | ------------- | --------------------------------------- |
| `soat:ResourceTag/<key>` | Resource tags | Tag value on the target resource        |
| `soat:ResourceType`      | Request       | The type of the resource being accessed |

Operators and keys match **by exact string**; no case conversion applies to a `condition` block or to `tags` (see [Tag keys are stored verbatim](#tag-keys-are-stored-verbatim)).

## Authorization Model

Authorization is **policy-only**: every decision is evaluated against the requested action and target SRN.

### Policy Resolution by Caller Type

| Caller type                   | Policies used                                                               |
| ----------------------------- | --------------------------------------------------------------------------- |
| **Admin (JWT)**               | Bypassed — admins have unrestricted access to all resources                 |
| **Regular user (JWT)**        | All policies attached to the user (via `User.policyIds`)                    |
| **API key (no policies)**     | Inherits the owning user's policies, hard-locked to the key's project        |
| **API key (with policies)**   | Intersection of user policies and key policies — both must allow the action |
| **OAuth token**               | Intersection of user policies and the consented scope, hard-locked to the token's project |

Every API key is hard-locked to its `project_id`, every OAuth token to its `prj`; any other project is denied regardless of policy or role. An `admin` owner cannot cross a scoped credential's project boundary: admin lifts the policy ceiling within scope and passes the role-gated project create/delete, never the scope binding, so a cross-project resource write returns `403 API_KEY_PROJECT_SCOPE`. See [Project scope is a hard boundary, even for admins](./api-keys.md#project-scope-is-a-hard-boundary-even-for-admins).

### Why Intersection Semantics Matter

A key with policies, or an OAuth token with a consented scope, **never exceeds its owning user's permissions**: the user's policies are the ceiling. This is what makes [API keys](./api-keys.md) and [OAuth tokens](./oauth.md#permission-enforcement) safe to delegate; one evaluator enforces every credential type.

### Authorization by Caller Type

| Scenario                                                            | Result  | Reason                                   |
| ------------------------------------------------------------------- | ------- | ---------------------------------------- |
| Admin accessing any resource                                        | Allowed | Admins bypass policy evaluation          |
| User with `resource: ["srn:proj_A:*:*"]` accessing proj_A          | Allowed | Policy covers the SRN                    |
| User with `resource: ["srn:proj_A:*:*"]` accessing proj_B          | Denied  | Policy does not cover proj_B SRN         |
| API key scoped to proj_A, accessing proj_B                          | Denied  | Key is hard-locked to proj_A             |
| API key with key policy allowed, but user policy denied             | Denied  | Intersection semantics — both must allow |
| API key without policies, accessing resource allowed by user policy | Allowed | Key inherits user permissions            |

### What a Denial Looks Like

A denial's status code depends on what the route does, not on which policy failed:

| Route shape                                                             | Denied response                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **List** ([`GET /agents`](/docs/api/agents/list-agents))                                                 | `200` with an empty list — the caller may read zero projects, so nothing matches      |
| **Read one** ([`GET /agents/{id}`](/docs/api/agents/get-agent))                                        | `404 RESOURCE_NOT_FOUND` — existence is not leaked for a resource the caller can't see |
| **Write / act on one** ([`PATCH /agents/{id}`](/docs/api/agents/patch-agent), `POST .../release/promote`) | `403 FORBIDDEN`                                                                        |
| **Create** ([`POST /agents`](/docs/api/agents/create-agent))                                             | `403 FORBIDDEN`                                                                        |
| Scoped credential targeting another project                             | `403 API_KEY_PROJECT_SCOPE`, naming both projects                                     |

A write is refused **before** body validation, so an unauthorized caller gets `403` whether the body is well-formed or not.

## Policy Evaluation

Policy evaluation (Layer 2) follows AWS IAM semantics:

1. **Default deny** — if no statement matches, access is denied.
2. **Explicit deny wins** — if any statement explicitly denies, access is denied regardless of allows.
3. **Allow** — if at least one statement allows and no statement denies, access is granted.

### Statement Matching

A statement matches a request when **all** of the following are true:

1. At least one pattern in `action` matches the requested action.
2. At least one pattern in `resource` matches the target SRN (or `resource` is omitted / `["*"]`).
3. All `condition` blocks evaluate to true (or `condition` is omitted).

### Pattern Matching

- `*` matches everything.
- `module:*` matches all actions in a module.
- `srn:proj_ABC:document:*` matches all documents in a project.
- Wildcards apply only at segment boundaries — partial wildcards like `doc_X*` are not supported.
- **Path-based patterns**: when a resource has a `path` field, the resource ID segment of the SRN may be a logical path. Both the resource's `id` and its `path` are tested when evaluating a single-resource check. Glob patterns (`/reports/*`) are expanded to SQL `LIKE` for list queries.

## Tags

Tags are key-value pairs on resources, enabling ABAC via conditions. One mechanism serves every tagged resource — actors, conversations, documents, files, sessions, memories and memory entries — so a tag is written, filtered and matched the same way everywhere:

| Surface | Rule |
|---|---|
| Write (`tags` on create/update, `PUT`/`PATCH …/tags`) | A flat object of string values; anything else (an array, a nested object, a number) is `400 VALIDATION_FAILED`, never coerced |
| List filter (`?tags=key:value`, repeatable) | JSONB containment: every pair present with exactly that value; split on the first colon; a pair without a colon is `400` |
| Knowledge search (`tags` in the body) | Same containment rule across documents and memory entries |
| Policy condition (`soat:ResourceTag/<key>`) | Same pairs, read from the same column |

Which resources honor `soat:ResourceTag/<key>` in a policy condition today: actors, conversations, documents, files. Sessions, memories and memory entries store and filter tags but do not yet evaluate them in policies (tracked in [#1278](https://github.com/ttoss/soat/issues/1278) and [#1279](https://github.com/ttoss/soat/issues/1279)).

```json
{
  "tags": {
    "environment": "production",
    "team": "engineering",
    "sensitivity": "high"
  }
}
```

Managed via each resource's `tags` field or the tag sub-endpoints:

```
PUT    /api/v1/<resource>/:id/tags    Replace all tags
PATCH  /api/v1/<resource>/:id/tags    Merge tags
GET    /api/v1/<resource>/:id/tags    Get tags
```

The response of all three is the tag map itself, not the resource. Every list endpoint of a tagged resource accepts the same filter:

```
GET /api/v1/<resources>?tags=env:prod&tags=team:finance
```

### Tag keys are stored verbatim

A tag key is an opaque label, **never case-converted**: stored, returned, and matched against `soat:ResourceTag/<key>` exactly as written, on REST, in formation templates, and over MCP.

- `cost_center` and `costCenter` are **two different tags**; a policy naming one does not match a resource carrying only the other.
- `GET .../tags` returns the stored key verbatim; copy it into `soat:ResourceTag/<key>`.

## Examples

### Full Access Policy

`resource: ["*"]` matches every SRN across all projects.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["*"],
      "resource": ["*"]
    }
  ]
}
```

### Project-scoped Read-only Policy

Read access to one project's resources; attach to a user or API key.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": [
        "projects:GetProject",
        "documents:GetDocument",
        "documents:ListDocuments",
        "files:GetFile",
        "files:ListFiles"
      ],
      "resource": ["srn:proj_ABC:*:*"]
    }
  ]
}
```

### Allow All File Operations Except Delete

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["files:*"],
      "resource": ["srn:proj_ABC:file:*"]
    },
    {
      "effect": "Deny",
      "action": ["files:DeleteFile"],
      "resource": ["srn:proj_ABC:file:*"]
    }
  ]
}
```

### Condition-based Access

Allow only actors tagged `"internal"`:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["actors:GetActor"],
      "resource": ["srn:proj_ABC:actor:*"],
      "condition": {
        "StringEquals": {
          "soat:ResourceTag/visibility": "internal"
        }
      }
    }
  ]
}
```

---

## Users

For user identity management, roles, authentication, and bootstrap, see the [Users module](./users.md).
