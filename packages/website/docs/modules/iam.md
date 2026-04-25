---
sidebar_position: 1
---

# IAM

The IAM (Identity and Access Management) module provides authentication, identity management, and fine-grained authorization for the SOAT platform. It implements an AWS IAM-inspired policy engine with structured policy statements supporting `Effect`, `Action`, `Resource`, and `Condition`.

## Overview

SOAT uses a policy-based access control model. Every API request is authenticated via JWT (for users) or project key (for project-scoped clients). Authorization is evaluated in two layers: first the caller's **project membership** is verified, then the attached **policy documents** are run through the policy engine.

The IAM module covers:

- **Users** — identity management, roles, and JWT authentication (see [Users](#users) below)
- **Policy Documents** — structured permission rules attached to memberships and project keys
- **Policy Engine** — evaluation logic that resolves allow/deny decisions at request time
- **Authorization Model** — the two-layer model that combines project membership with policy evaluation (see [Authorization Model](#authorization-model) below)

## Authentication

SOAT supports two authentication methods. Both use the `Authorization: Bearer <token>` header.

### JWT (Users)

Users authenticate via `POST /api/v1/users/login` with username and password. The server returns a signed JWT containing the user's public ID and role. Admin users bypass policy evaluation and have unrestricted access. Regular users are authorized through their project membership policies.

### Project Keys

Project keys are prefixed with `pk_` and scoped to a single project. When an project key is used, authorization applies **intersection semantics**: both the owning user's membership policies _and_ the key's own attached policy must independently allow the action. This ensures project keys can never exceed the permissions of the user who created them.

## Policy Documents

A policy document is a JSON object containing one or more statements. Each statement describes a permission rule.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:ListDocuments"],
      "resource": ["soat:proj_ABC:document:doc_XYZ"]
    },
    {
      "effect": "Deny",
      "action": ["secrets:*"],
      "resource": ["soat:proj_ABC:secret:sec_PROD_KEY"]
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

Policy documents are created and managed under a project via the project policy endpoints (see [Projects](projects.md)).

## SOAT Resource Names (SRNs)

Every addressable entity has a canonical identifier called a SOAT Resource Name:

```
soat:<project_id>:<resource_type>:<resource_id>
```

Examples:

| SRN                              | Description                |
| -------------------------------- | -------------------------- |
| `soat:proj_ABC:document:doc_XYZ` | A specific document        |
| `soat:proj_ABC:document:*`       | All documents in a project |
| `soat:proj_ABC:file:*`           | All files in a project     |
| `soat:proj_ABC:actor:act_123`    | A specific actor           |
| `soat:*:*:*`                     | Everything (admin-level)   |

### Project Segment and Policy Scoping

Because policies always belong to a single project (see [Projects — Policy Documents](projects.md#policy-documents)), and are only evaluated against resources within that same project (see [Authorization Model](#authorization-model)), the `<project_id>` segment in an SRN is **automatically constrained** by the policy's own project scope.

In practice this means:

- `resource: ["*"]` — matches all resources in the policy's project. This is the **recommended** form for broad access.
- `resource: ["soat:proj_ABC:document:*"]` — valid only if this policy belongs to `proj_ABC`. If it belongs to a different project, this pattern will never match any resource (it becomes a dead statement).

You do **not** need to specify the project ID in resource patterns to limit cross-project access — that restriction is enforced by project membership at Layer 1 of the [Authorization Model](#authorization-model). The project segment exists for namespacing and forward compatibility, not for access control between projects.

:::tip
When writing policies, prefer `resource: ["*"]` for broad access within the project. Use specific SRNs only when you need to restrict access to individual resources:

```json
{ "resource": ["soat:proj_ABC:document:doc_XYZ"] }
```

There is no need to specify the project ID to prevent cross-project access — project membership already enforces that.
:::

### Resource Types

| Resource Type  | Public ID Prefix | Module        |
| -------------- | ---------------- | ------------- |
| `document`     | `doc_`           | Documents     |
| `file`         | `file_`          | Files         |
| `actor`        | `act_`           | Actors        |
| `conversation` | `conv_`          | Conversations |
| `project`      | `proj_`          | Projects      |
| `policy`       | `pol_`           | Policies      |
| `api-key`      | `key_`           | project keys  |

## Actions

Actions follow the `module:Operation` pattern. Each module defines its own set of actions documented in the **Permissions** section of the respective module page:

- [Actors Permissions](actors.md#permissions)
- [Conversations Permissions](conversations.md#permissions)
- [Documents Permissions](documents.md#permissions)
- [Files Permissions](files.md#permissions)
- [Projects Permissions](projects.md#permissions)
- [Project Keys Permissions](projects.md#project-key-permissions)
- [Users Permissions](#user-permissions)

### Wildcards

- `*` — matches all actions across all modules
- `module:*` — matches all actions in a specific module (e.g., `documents:*`)

## Conditions

Conditions add attribute-based constraints to statements. A condition block maps an operator to one or more key-value pairs that must all evaluate to true.

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

## Authorization Model

Authorization in SOAT is a **two-layer** process. Both layers must pass for a request to be allowed.

### Layer 1 — Project Membership

Before any policy is evaluated, the server checks whether the caller has access to the target project:

| Caller type            | Membership check                                                         |
| ---------------------- | ------------------------------------------------------------------------ |
| **Admin (JWT)**        | Bypassed — admins have unrestricted access to all projects               |
| **Regular user (JWT)** | Must be a member of the target project (`UserProject` record must exist) |
| **Project key**        | Locked to the single project the key was created for                     |

If the membership check fails, the request is denied with `403 Forbidden` — policy evaluation never runs.

### Layer 2 — Policy Evaluation

Only after membership is confirmed does the server load the caller's policies and evaluate them against the requested action and resource SRN.

### Why This Matters

A policy with `resource: ["*"]` grants access to **all resources within the projects the caller is a member of** — not all resources globally. The wildcard matches any SRN pattern, but the membership check restricts which projects the caller can reach in the first place.

For example, if Alice is a member of `proj_A` with a policy containing `resource: ["*"]`, she can access all resources in `proj_A`. She **cannot** access resources in `proj_B` unless she is separately added as a member of `proj_B` with its own policies.

### Authorization by Caller Type

| Scenario                                                                                    | Result  | Reason                                      |
| ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| Admin accessing any resource                                                                | Allowed | Admins bypass both layers                   |
| User member of proj_A with `resource: ["*"]`, accessing proj_A                              | Allowed | Membership passes, policy matches           |
| User member of proj_A with `resource: ["*"]`, accessing proj_B                              | Denied  | Not a member of proj_B — blocked at Layer 1 |
| Project key for proj_A, accessing proj_B                                                    | Denied  | Key is locked to proj_A                     |
| Project key for proj_A, action allowed by key policy but denied by user's membership policy | Denied  | Intersection semantics — both must allow    |

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
- `soat:proj_ABC:document:*` matches all documents in a project.
- Wildcards apply only at segment boundaries — partial wildcards like `doc_X*` are not supported.
- **Path-based patterns**: when a resource has a `path` field, the resource ID segment of the SRN may be a logical path. Both the resource's `id` and its `path` are tested when evaluating a single-resource check. Glob patterns (`/reports/*`) are expanded to SQL `LIKE` for list queries.

## Tags

Tags are key-value pairs attached to resources. They enable attribute-based access control (ABAC) via conditions. Taggable resources include documents, files, actors, and conversations.

```json
{
  "tags": {
    "environment": "production",
    "team": "engineering",
    "sensitivity": "high"
  }
}
```

Tags are managed via each resource's create/update endpoints using the `tags` field, or through dedicated tag sub-endpoints:

```
PUT    /api/v1/<resource>/:id/tags    Replace all tags
PATCH  /api/v1/<resource>/:id/tags    Merge tags
GET    /api/v1/<resource>/:id/tags    Get tags
```

## Examples

### Full Admin Policy

Equivalent to unrestricted access **within the project this policy is attached to**. The `resource: ["*"]` wildcard matches all SRNs, but the caller can only reach projects they are a member of (see [Authorization Model](#authorization-model)).

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["*"],
      "resource": ["*"]
    }
  ]
}
```

### Read-only Across All Modules

Grants read access to documents, files, actors, and conversations **within the project**. Attach the same policy to multiple project memberships to grant the same permissions across projects.

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": [
        "documents:GetDocument",
        "documents:ListDocuments",
        "documents:SearchDocuments",
        "files:GetFile",
        "files:DownloadFile",
        "actors:ListActors",
        "actors:GetActor",
        "conversations:ListConversations",
        "conversations:GetConversation"
      ],
      "resource": ["*"]
    }
  ]
}
```

### Allow All File Operations Except Delete

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["files:*"],
      "resource": ["soat:proj_ABC:file:*"]
    },
    {
      "effect": "Deny",
      "action": ["files:DeleteFile"],
      "resource": ["soat:proj_ABC:file:*"]
    }
  ]
}
```

### Condition-based Access

Allow only actors tagged `"internal"`:

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["actors:GetActor"],
      "resource": ["soat:proj_ABC:actor:*"],
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

The Users section covers identity management and authentication. Users authenticate via username and password and receive a JWT for subsequent requests.

A User has a username, a hashed password, and a role (`admin` or `user`). Users are identified by an `id` prefixed with `user_`. Passwords are hashed with bcrypt and never returned in API responses.

The first user is created via the **bootstrap** endpoint, which is only available when no users exist. Subsequent users are created by admins.

## Roles

| Role    | Description                                                                 |
| ------- | --------------------------------------------------------------------------- |
| `admin` | Full access to all resources and operations. Bypasses policy evaluation.    |
| `user`  | Access determined by project membership policies. Must be a project member. |

### User Data Model

| Field        | Type   | Description                             |
| ------------ | ------ | --------------------------------------- |
| `id`         | string | Public identifier prefixed with `user_` |
| `username`   | string | Unique username                         |
| `role`       | string | `"admin"` or `"user"`                   |
| `created_at` | string | ISO 8601 creation timestamp             |
| `updated_at` | string | ISO 8601 last-updated timestamp         |

Sensitive fields (`passwordHash`, internal numeric ID) are never exposed in responses.

### Bootstrap

The `POST /api/v1/users/bootstrap` endpoint creates the first admin user. It is only available when the user table is empty and returns `409 Conflict` if any user already exists. This endpoint does not require authentication.

You can also bootstrap an admin automatically on server startup by setting two environment variables:

```env
SOAT_ADMIN_USERNAME=admin
SOAT_ADMIN_PASSWORD=supersecret
```

When both variables are present and no users exist in the database, the server creates the admin user before accepting requests. If users already exist, the variables are ignored and startup continues normally.

### User Authentication

Users authenticate with `POST /api/v1/users/login`, providing `username` and `password`. On success, the server returns a signed JWT containing the user's public ID and role. The token is passed as `Authorization: Bearer <token>` on subsequent requests.

### User Permissions

User management is restricted to admin users. These operations are not governed by the policy engine — they require the `admin` role directly.

| Action         | Permission      | REST Endpoint                  | MCP Tool |
| -------------- | --------------- | ------------------------------ | -------- |
| List users     | Admin only      | `GET /api/v1/users`            | —        |
| Get user by ID | Admin only      | `GET /api/v1/users/:id`        | —        |
| Create user    | Admin only      | `POST /api/v1/users`           | —        |
| Delete user    | Admin only      | `DELETE /api/v1/users/:id`     | —        |
| Bootstrap      | Unauthenticated | `POST /api/v1/users/bootstrap` | —        |
| Login          | Unauthenticated | `POST /api/v1/users/login`     | —        |

See the [API Reference](../api/users/list-users) for full endpoint details, request/response schemas, and status codes.
