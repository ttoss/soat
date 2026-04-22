---
sidebar_position: 3
---

# Secrets

The Secrets module provides encrypted storage for sensitive values such as API keys and credentials. Values are encrypted at rest using AES-256-GCM and are never returned by any API response.

## Overview

Secrets are associated with a project. Once stored, a secret's value can only be replaced — it is never readable again. All operations return a `hasValue` boolean to indicate whether an encrypted value is on file.

Secrets can be linked to [AI Providers](./ai-providers.md) to supply credentials at inference time.

## Configuration

| Environment Variable     | Required | Description                                                                                      |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `SECRETS_ENCRYPTION_KEY` | Yes      | 64-character hex string (32 bytes). Used for AES-256-GCM encryption of all stored secret values. |

Generate a key with:

```bash
openssl rand -hex 32
```

## Data Model

| Field       | Type    | Description                              |
| ----------- | ------- | ---------------------------------------- |
| `id`        | string  | Public identifier (e.g. `sec_…`)         |
| `projectId` | string  | ID of the owning project                 |
| `name`      | string  | Human-readable label                     |
| `hasValue`  | boolean | `true` when an encrypted value is stored |
| `createdAt` | string  | ISO 8601 creation timestamp              |
| `updatedAt` | string  | ISO 8601 last-updated timestamp          |

## Deletion behaviour

By default, deleting a secret that is still referenced by one or more AI providers returns `409 Conflict`. Pass `?force=true` to cascade-delete the dependent AI providers along with the secret.

## Permissions

| Action        | Permission             | REST Endpoint                      | MCP Tool        |
| ------------- | ---------------------- | ---------------------------------- | --------------- |
| List secrets  | `secrets:ListSecrets`  | `GET /api/v1/secrets`              | `list-secrets`  |
| Get a secret  | `secrets:GetSecret`    | `GET /api/v1/secrets/:secretId`    | `get-secret`    |
| Create secret | `secrets:CreateSecret` | `POST /api/v1/secrets`             | `create-secret` |
| Update secret | `secrets:UpdateSecret` | `PATCH /api/v1/secrets/:secretId`  | `update-secret` |
| Delete secret | `secrets:DeleteSecret` | `DELETE /api/v1/secrets/:secretId` | `delete-secret` |
