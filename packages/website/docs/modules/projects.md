# Projects Module

The Projects module provides multi-tenant namespaces in SOAT. Every resource (document, file, actor, conversation) belongs to a project. Projects also own policy documents, manage user membership, and issue project keys for programmatic access.

## Overview

A Project is a top-level container that scopes all resources. Users access projects through membership, and their permissions within a project are determined by attached policy documents. Projects are identified by an `id` prefixed with `proj_`.

## Data Model

| Field       | Type   | Description                             |
| ----------- | ------ | --------------------------------------- |
| `id`        | string | Public identifier prefixed with `proj_` |
| `name`      | string | Human-readable project name             |
| `createdAt` | string | ISO 8601 creation timestamp             |
| `updatedAt` | string | ISO 8601 last-updated timestamp         |

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
| `projectId`   | string | ID of the owning project               |
| `createdAt`   | string | ISO 8601 creation timestamp            |
| `updatedAt`   | string | ISO 8601 last-updated timestamp        |

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
| List policies          | `projects:GetProject` | `GET /api/v1/projects/:projectId/policies`                 | —               |
| Get policy             | `projects:GetProject` | `GET /api/v1/projects/:projectId/policies/:policyId`       | —               |
| Create policy          | Admin only            | `POST /api/v1/projects/:projectId/policies`                | —               |
| Update policy          | Admin only            | `PUT /api/v1/projects/:projectId/policies/:policyId`       | —               |
| Delete policy          | Admin only            | `DELETE /api/v1/projects/:projectId/policies/:policyId`    | —               |
| Add member             | Admin only            | `POST /api/v1/projects/:projectId/members`                 | —               |
| Update member policies | Admin only            | `PUT /api/v1/projects/:projectId/members/:userId/policies` | —               |
| Get member policies    | Admin only            | `GET /api/v1/projects/:projectId/members/:userId/policies` | —               |

## Operations

### Create a Project

```http
POST /api/v1/projects
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "My Project"
}
```

**Response** `201 Created`

```json
{
  "id": "proj_abc123",
  "name": "My Project",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

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
  "projectId": "proj_abc123",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

### Add a Member to a Project

```http
POST /api/v1/projects/proj_abc123/members
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "userId": "user_def456",
  "policyIds": ["pol_def456"]
}
```

**Response** `201 Created`

### Update Member Policies

```http
PUT /api/v1/projects/proj_abc123/members/user_def456/policies
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "policyIds": ["pol_def456", "pol_ghi789"]
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
| `keyPrefix` | string | First 8 characters of the raw key (for lookup) |
| `userId`    | string | Public ID of the user who created the key      |
| `projectId` | string | Public ID of the project the key is scoped to  |
| `policyId`  | string | Public ID of the attached policy               |
| `createdAt` | string | ISO 8601 creation timestamp                    |
| `updatedAt` | string | ISO 8601 last-updated timestamp                |

The raw secret key is only returned in the `POST` response. Only `keyPrefix` and a bcrypt hash are stored.

### Security Model

- The raw key is a 32-byte random value prefixed with `pk_`.
- Only the `keyPrefix` (first 8 characters) and a bcrypt hash of the full key are stored.
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

### Project Key Operations

#### Create a Project Key

The caller must be a member of the target project. The policy must belong to the same project.

```http
POST /api/v1/project-keys
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "CI/CD Key",
  "projectId": "proj_abc123",
  "policyId": "pol_def456"
}
```

**Response** `201 Created`

```json
{
  "id": "key_ghi789",
  "name": "CI/CD Key",
  "keyPrefix": "pk_abcd",
  "key": "pk_abcdefghijklmnopqrstuvwxyz123456",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

:::caution
The `key` field is only returned once at creation time. Store it securely — it cannot be retrieved again.
:::

#### Get a Project Key

Returns metadata about the key. Only the key owner can access this.

```http
GET /api/v1/project-keys/key_ghi789
Authorization: Bearer <token>
```

**Response** `200 OK`

```json
{
  "id": "key_ghi789",
  "name": "CI/CD Key",
  "keyPrefix": "pk_abcd",
  "userId": "user_abc123",
  "projectId": "proj_abc123",
  "policyId": "pol_def456",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

#### Update a Key's Policy

Swap the attached policy. The new policy must belong to the same project as the key.

```http
PUT /api/v1/project-keys/key_ghi789
Authorization: Bearer <token>
Content-Type: application/json

{
  "policyId": "pol_xyz999"
}
```

**Response** `200 OK`
