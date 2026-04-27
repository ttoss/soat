# API Keys

The API Keys module provides long-lived programmatic credentials for users. An API key authenticates as its owning user and optionally restricts access to a single project and/or a subset of that user's policies.

## Overview

API keys are prefixed with `sk_` and are identified in the system by a public `id` prefixed with `key_`. The raw key value is returned **only at creation time** and cannot be retrieved again. A truncated `key_prefix` (first 8 characters) is stored for identification.

API keys use the standard `Authorization: Bearer <key>` header — the same as JWTs.

## Data Model

| Field        | Type     | Description                                                                   |
| ------------ | -------- | ----------------------------------------------------------------------------- |
| `id`         | string   | Public identifier prefixed with `key_`                                        |
| `name`       | string   | Human-readable label                                                          |
| `key_prefix` | string   | First 8 characters of the raw key (for identification, never the full secret) |
| `user_id`    | string   | Public ID of the owning user                                                  |
| `project_id` | string   | Optional — restricts key to a single project                                  |
| `policy_ids` | string[] | Optional — public IDs of policies that further restrict key permissions       |
| `created_at` | string   | ISO 8601 creation timestamp                                                   |
| `updated_at` | string   | ISO 8601 last-updated timestamp                                               |

## Key Concepts

### Permission Inheritance

The effective permissions of an API key depend on what is attached to it:

| Configuration                      | Effective permissions                                                      |
| ---------------------------------- | -------------------------------------------------------------------------- |
| No `project_id`, no `policy_ids`   | Full user permissions across all projects                                  |
| `project_id` only                  | User permissions, restricted to that project                               |
| `policy_ids` only                  | Intersection of user policies and key policies, across all projects        |
| Both `project_id` and `policy_ids` | Intersection of user policies and key policies, restricted to that project |

**Intersection semantics:** when a key has `policy_ids`, both the user's policies **and** the key's own policies must independently allow the requested action. The key can never exceed the permissions of the user who owns it.

### Project Scoping

When `project_id` is set on a key, any request made with that key is hard-locked to that project. Attempts to access resources in any other project are denied regardless of what the policies say.

### Policy Attachment

Policies listed in `policy_ids` are loaded from the global [Policies](./policies.md) store. The `policy_ids` list on a key stores integer internal IDs; the REST API accepts and returns the public `pol_`-prefixed IDs.

### Revoking a Key

Delete the key via `DELETE /api/v1/api-keys/:id`. The key immediately stops authenticating. There is no rotation endpoint — create a new key and delete the old one.

## Creating an API Key

```http
POST /api/v1/api-keys
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "name": "CI/CD Pipeline",
  "project_id": "proj_V1StGXR8Z5jdHi6B",
  "policy_ids": ["pol_V1StGXR8Z5jdHi6B"]
}
```

**Response** `201 Created`

```json
{
  "id": "key_V1StGXR8Z5jdHi6B",
  "name": "CI/CD Pipeline",
  "key_prefix": "sk_a1b2c3",
  "key": "sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "user_id": "usr_V1StGXR8Z5jdHi6B",
  "project_id": "proj_V1StGXR8Z5jdHi6B",
  "policy_ids": ["pol_V1StGXR8Z5jdHi6B"],
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

Store the `key` value securely — it is never returned again.

## Permissions

| Action         | Permission     | REST Endpoint                 | MCP Tool         |
| -------------- | -------------- | ----------------------------- | ---------------- |
| Create API key | Authenticated  | `POST /api/v1/api-keys`       | `create-api-key` |
| Get API key    | Owner or admin | `GET /api/v1/api-keys/:id`    | `get-api-key`    |
| Update API key | Owner or admin | `PUT /api/v1/api-keys/:id`    | `update-api-key` |
| Delete API key | Owner or admin | `DELETE /api/v1/api-keys/:id` | `delete-api-key` |
