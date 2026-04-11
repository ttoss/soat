# IAM Module

The IAM (Identity and Access Management) module controls who can access SOAT and what they are allowed to do. It provides user authentication, project-based organization, fine-grained permission policies, and API keys for programmatic access.

## Overview

Every resource in SOAT (files, projects, and more) is protected by IAM. Before any action is performed, IAM verifies:

1. **Who are you?** — Authentication via a login session (JWT) or an API key.
2. **Are you allowed to do that?** — Authorization via policies attached to your project membership.

## Authentication

### Login (JWT)

Human users authenticate by logging in with their credentials. SOAT returns a session token that you include in every subsequent request.

```
POST /api/v1/users/login
```

```json
{
  "email": "you@example.com",
  "password": "your-password"
}
```

Include the token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Session tokens expire after 7 days.

### API Keys

For scripts, integrations, or any machine-to-machine access, use an API key instead of a login token. API keys are long-lived and can be scoped to a specific set of permissions.

Create a key via `POST /api/v1/api-keys`. The full key value is returned **only once** at creation — store it securely. Use it exactly like a session token:

```
Authorization: Bearer sk_<your-api-key>
```

An API key's effective permissions are the **intersection** of the key's own policy and the key owner's project membership policy. Both must allow an action for it to be permitted. A key can never grant more access than the owner's membership policy allows, and can be scoped to even less via the key's own policy.

## Roles

| Role    | Description                                             |
| ------- | ------------------------------------------------------- |
| `admin` | Full access to all resources and management operations. |
| `user`  | Access governed by project membership and policies.     |

The first user registered via `POST /api/v1/users/bootstrap` becomes the admin. All subsequent users have the `user` role.

## Projects

A project is the top-level organizational unit in SOAT. All resources — files, policies, and API keys — belong to a project.

- **Admins** can create, manage, and delete any project.
- **Users** can access only the projects they are members of.
- Each project membership carries a **policy** that defines what that member is allowed to do.

## Policies

A policy defines what actions a member (or API key) is allowed or denied within a project.

```json
{
  "name": "read-only",
  "projectId": "proj_...",
  "permissions": ["files:*"],
  "notPermissions": ["files:DeleteFile"]
}
```

| Field            | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `permissions`    | Actions the policy allows. Supports wildcards (`files:*`, `*`).            |
| `notPermissions` | Actions the policy explicitly denies. Denials take precedence over allows. |

### Permission Actions

Permission strings follow the format `resource:Action`. The table below lists all available actions and the REST endpoint each one protects.

| Permission Action                  | REST Endpoint                      | What it controls                                    |
| ---------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `files:GetFile`                    | `GET /api/v1/files/:id`            | Retrieve file metadata                              |
| `files:CreateFile`                 | `POST /api/v1/files`               | Create a new file record                            |
| `files:UploadFile`                 | `POST /api/v1/files/upload`        | Upload file content                                 |
| `files:DownloadFile`               | `GET /api/v1/files/:id/download`   | Download file content                               |
| `files:UpdateFileMetadata`         | `PATCH /api/v1/files/:id/metadata` | Update file metadata                                |
| `files:DeleteFile`                 | `DELETE /api/v1/files/:id`         | Delete a file                                       |
| `projects:GetProject`              | `GET /api/v1/projects/:id`         | View a project's details                            |
| `documents:GetDocument`            | `GET /api/v1/documents/:id`        | Retrieve a document                                 |
| `documents:CreateDocument`         | `POST /api/v1/documents`           | Create a document                                   |
| `documents:DeleteDocument`         | `DELETE /api/v1/documents/:id`     | Delete a document                                   |
| `actors:GetActor`                  | `GET /api/v1/actors/:id`           | Retrieve an actor                                   |
| `actors:CreateActor`               | `POST /api/v1/actors`              | Create an actor                                     |
| `actors:DeleteActor`               | `DELETE /api/v1/actors/:id`        | Delete an actor                                     |
| `conversations:GetConversation`    | `GET /api/v1/conversations/:id`    | Retrieve a conversation and its messages and actors |
| `conversations:CreateConversation` | `POST /api/v1/conversations`       | Create a conversation                               |
| `conversations:UpdateConversation` | `PATCH /api/v1/conversations/:id`  | Update a conversation, add or remove messages       |
| `conversations:DeleteConversation` | `DELETE /api/v1/conversations/:id` | Delete a conversation                               |

Use wildcards to grant broader access:

| Pattern         | Effect                      |
| --------------- | --------------------------- |
| `*`             | Allow everything            |
| `files:*`       | Allow all file operations   |
| `files:GetFile` | Allow only retrieving files |

## API Keys

Each API key is attached to a policy, which limits the key to a specific set of actions. When a request uses an API key, both the key's policy and the owner's membership policy must allow the action.

| Field      | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| `name`     | A human-readable label for the key                                           |
| `policyId` | The policy that governs this key's permissions                               |
| `key`      | The raw key value — **shown only once at creation, never retrievable again** |

## OAuth

> **Coming soon.** OAuth 2.0 support (Authorization Code and Client Credentials flows) is planned for a future release.
