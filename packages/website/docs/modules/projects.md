# Projects

The Projects module provides multi-tenant namespaces in SOAT. Every resource ([document](./documents.md), [file](./files.md), [actor](./actors.md), [conversation](./conversations.md)) belongs to a project. Projects are identified by an `id` prefixed with `proj_`.

## Overview

A Project is a top-level container that scopes all resources. Users access projects through policy-based authorization — there is no separate membership table. Whether a user can access a project is determined entirely by the [policies](./policies.md) attached to their account and the SRN patterns those policies contain.

## Data Model

| Field        | Type   | Description                             |
| ------------ | ------ | --------------------------------------- |
| `id`         | string | Public identifier prefixed with `proj_` |
| `name`       | string | Human-readable project name             |
| `created_at` | string | ISO 8601 creation timestamp             |
| `updated_at` | string | ISO 8601 last-updated timestamp         |

## Key Concepts

### Project Access via Policies

Users no longer need to be explicitly added to a project as members. Access is granted by attaching a [Policy](./policies.md) to the user (or their API key) that contains an `Allow` statement covering the relevant project's SRN pattern:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["projects:GetProject", "files:ListFiles", "files:GetFile"],
      "resource": ["soat:proj_ABC:*:*"]
    }
  ]
}
```

To grant a user access to all projects, use a wildcard project segment:

```json
{ "resource": ["soat:*:*:*"] }
```

### Visibility Rules

- **Admin users** see all projects.
- **API key callers** scoped to a project see only that project.
- **Regular users** see only the projects covered by the SRN patterns in their attached policies.

### Authorization Model

Authorization is policy-only — there is no Layer 1 membership gate. All access decisions are evaluated through the policy engine against the requested action and the resource SRN. See [IAM](./iam.md) for details.

## Permissions

Project CRUD is restricted to admin users. Reading a project requires the `projects:GetProject` action to be allowed by the caller's policies.

| Action            | Permission            | REST Endpoint                 | MCP Tool        |
| ----------------- | --------------------- | ----------------------------- | --------------- |
| List projects     | Authenticated         | `GET /api/v1/projects`        | `list-projects` |
| Get project by ID | `projects:GetProject` | `GET /api/v1/projects/:id`    | `get-project`   |
| Create project    | Admin only            | `POST /api/v1/projects`       | —               |
| Delete project    | Admin only            | `DELETE /api/v1/projects/:id` | —               |

**Response** `201 Created`

### Update Member Policies

```http
PUT /api/v1/projects/proj_abc123/members/user_def456/policies
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "policy_ids": ["pol_def456", "pol_ghi789"]
}
```

**Response** `200 OK`

---

## API Keys

API Keys provide key-based authentication for programmatic access to SOAT. Each key is scoped to a single project and bound to a single policy document. The raw key is returned only once at creation time — it cannot be retrieved afterwards.

API Keys are identified by an `id` prefixed with `key_`.

### API Key Data Model

| Field        | Type   | Description                                    |
| ------------ | ------ | ---------------------------------------------- |
| `id`         | string | Public identifier prefixed with `key_`         |
| `name`       | string | Human-readable label                           |
| `key_prefix` | string | First 8 characters of the raw key (for lookup) |
| `user_id`    | string | Public ID of the user who created the key      |
| `project_id` | string | Public ID of the project the key is scoped to  |
| `policy_id`  | string | Public ID of the attached policy               |
| `created_at` | string | ISO 8601 creation timestamp                    |
| `updated_at` | string | ISO 8601 last-updated timestamp                |

The raw secret key is only returned in the `POST` response. Only `key_prefix` and a bcrypt hash are stored.

### Security Model

- The raw key is a 32-byte random value prefixed with `pk_`.
- Only the `key_prefix` (first 8 characters) and a bcrypt hash of the full key are stored.
- Authentication works by matching the prefix to candidate rows, then verifying the full key against each hash.

### Intersection Authorization

When an project key is used to make a request, authorization applies **intersection semantics**:

1. The owning user's project membership policies must allow the action.
2. The key's own attached policy must also allow the action.

Both must independently evaluate to `Allow`. This ensures a key can never exceed the permissions of the user who created it.

### Scoping

A project key is scoped to exactly one project. Requests made with the key can only access resources within that project. The project is resolved automatically from the key — callers do not need to specify the project explicitly.

### API Key Permissions

Project key operations require authentication. The creator of a key is the only user who can read or update it (ownership enforcement).

| Action            | Permission     | REST Endpoint              | MCP Tool |
| ----------------- | -------------- | -------------------------- | -------- |
| Create key        | Project member | `POST /api/v1/api-keys`    | —        |
| Get key by ID     | Key owner only | `GET /api/v1/api-keys/:id` | —        |
| Update key policy | Key owner only | `PUT /api/v1/api-keys/:id` | —        |
