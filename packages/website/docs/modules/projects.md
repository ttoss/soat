---
sidebar_position: 2
---

# Projects

The Projects module provides multi-tenant namespaces in SOAT. Every resource ([document](./documents.md), [file](./files.md), [actor](./actors.md), [conversation](./conversations.md)) belongs to a project. Projects also own policy documents, manage user membership, and issue project keys for programmatic access.

## Overview

A Project is a top-level container that scopes all resources. Users access projects through membership, and their permissions within a project are determined by attached policy documents. Projects are identified by an `id` prefixed with `proj_`.

## Data Model

| Field       | Type   | Description                             |
| ----------- | ------ | --------------------------------------- |
| `id`        | string | Public identifier prefixed with `proj_` |
| `name`      | string | Human-readable project name             |
| `created_at` | string | ISO 8601 creation timestamp             |
| `updated_at` | string | ISO 8601 last-updated timestamp         |

## Key Concepts

### Membership

Users are added to projects as members. Each membership associates the user with one or more policy documents that define what the user can do within that project. A user can be a member of multiple projects, each with different policies.

### Policy Documents

Policy documents are scoped to a project and contain structured IAM statements. See [IAM Module](iam.md) for the full policy format, evaluation logic, and examples.

**Policy data model:**

| Field         | Type   | Description                            |
| ------------- | ------ | -------------------------------------- |
| `id`          | string | Public identifier prefixed with `pol_` |
| `name`        | string | Human-readable label                   |
| `description` | string | Optional description                   |
| `document`    | object | Policy document (see [IAM](iam.md))    |
| `project_id`   | string | ID of the owning project               |
| `created_at`   | string | ISO 8601 creation timestamp            |
| `updated_at`   | string | ISO 8601 last-updated timestamp        |

### Visibility Rules

- **Admin users** see all projects.
- **project key callers** are restricted to the project the key is scoped to.
- **Regular users** see only projects they are members of.

## Permissions

Project CRUD and management operations are restricted to admin users. The `projects:GetProject` action is used by the policy engine for listing and reading policies as a member.

| Action                 | Permission            | REST Endpoint                                              | MCP Tool        |
| ---------------------- | --------------------- | ---------------------------------------------------------- | --------------- |
| List projects          | Authenticated         | `GET /api/v1/projects`                                     | `list-projects` |
| Get project by ID      | Authenticated         | `GET /api/v1/projects/:id`                                 | `get-project`   |
| Create project         | Admin only            | `POST /api/v1/projects`                                    | —               |
| Delete project         | Admin only            | `DELETE /api/v1/projects/:id`                              | —               |
| List policies          | `projects:GetProject` | `GET /api/v1/projects/:project_id/policies`                 | —               |
| Get policy             | `projects:GetProject` | `GET /api/v1/projects/:project_id/policies/:policy_id`       | —               |
| Create policy          | Admin only            | `POST /api/v1/projects/:project_id/policies`                | —               |
| Update policy          | Admin only            | `PUT /api/v1/projects/:project_id/policies/:policy_id`       | —               |
| Delete policy          | Admin only            | `DELETE /api/v1/projects/:project_id/policies/:policy_id`    | —               |
| Add member             | Admin only            | `POST /api/v1/projects/:project_id/members`                 | —               |
| Update member policies | Admin only            | `PUT /api/v1/projects/:project_id/members/:user_id/policies` | —               |
| Get member policies    | Admin only            | `GET /api/v1/projects/:project_id/members/:user_id/policies` | —               |

### Create a Policy

```http
POST /api/v1/projects/proj_abc123/policies
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "Read-only Documents",
  "description": "Allows reading all documents",
  "document": {
    "version": "2025-01-01",
    "statement": [
      {
        "effect": "Allow",
        "action": ["documents:GetDocument", "documents:ListDocuments"],
        "resource": ["*"]
      }
    ]
  }
}
```

**Response** `201 Created`

```json
{
  "id": "pol_def456",
  "name": "Read-only Documents",
  "description": "Allows reading all documents",
  "document": { "...": "..." },
  "project_id": "proj_abc123",
  "created_at": "2025-01-01T00:00:00.000Z",
  "updated_at": "2025-01-01T00:00:00.000Z"
}
```

### Add a Member to a Project

```http
POST /api/v1/projects/proj_abc123/members
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "user_id": "user_def456",
  "policy_ids": ["pol_def456"]
}
```

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

## Project Keys

Project Keys provide project key-based authentication for programmatic access to SOAT. Each key is scoped to a single project and bound to a single policy document. The raw key is returned only once at creation time — it cannot be retrieved afterwards.

Project Keys are identified by an `id` prefixed with `key_`.

### Project Key Data Model

| Field       | Type   | Description                                    |
| ----------- | ------ | ---------------------------------------------- |
| `id`        | string | Public identifier prefixed with `key_`         |
| `name`      | string | Human-readable label                           |
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

### Project Key Permissions

Project key operations require authentication. The creator of a key is the only user who can read or update it (ownership enforcement).

| Action            | Permission     | REST Endpoint                  | MCP Tool |
| ----------------- | -------------- | ------------------------------ | -------- |
| Create key        | Project member | `POST /api/v1/project-keys`    | —        |
| Get key by ID     | Key owner only | `GET /api/v1/project-keys/:id` | —        |
| Update key policy | Key owner only | `PUT /api/v1/project-keys/:id` | —        |
