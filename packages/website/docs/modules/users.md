# Users

The Users module manages human identities within SOAT. A user can authenticate via username/password and receive a JWT token used for subsequent requests.

## Overview

Users are global to the SOAT instance (not scoped to a project). The first user is created via the bootstrap endpoint. After that, only authenticated admin users may create additional users.

Users can have [Policies](./policies.md) attached to them, which control what resources and operations they are permitted to access.

## Data Model

| Field        | Type   | Description                      |
| ------------ | ------ | -------------------------------- |
| `id`         | string | Public identifier (e.g. `usr_…`) |
| `username`   | string | Unique login name                |
| `created_at` | string | ISO 8601 creation timestamp      |
| `updated_at` | string | ISO 8601 last-updated timestamp  |

## Permissions

| Action               | Permission                 | REST Endpoint                         | MCP Tool               |
| -------------------- | -------------------------- | ------------------------------------- | ---------------------- |
| List users           | `users:ListUsers`          | `GET /api/v1/users`                   | `list-users`           |
| Create user          | `users:CreateUser`         | `POST /api/v1/users`                  | `create-user`          |
| Get user             | `users:GetUser`            | `GET /api/v1/users/:id`               | `get-user`             |
| Delete user          | `users:DeleteUser`         | `DELETE /api/v1/users/:id`            | `delete-user`          |
| Get user policies    | `users:GetUserPolicies`    | `GET /api/v1/users/:userId/policies`  | `get-user-policies`    |
| Attach user policies | `users:AttachUserPolicies` | `POST /api/v1/users/:userId/policies` | `attach-user-policies` |
