# IAM Module

The IAM (Identity and Access Management) module provides authentication and authorization primitives for SOAT-powered applications. It manages identities through **Users** and **API Keys**, and controls access to resources using **Projects**, **Policies**, and **Project Members**.

## Overview

The IAM module controls who can access your resources and what actions they can perform. It supports:

- **Human users** with username/password authentication and JWT session tokens
- **Machine-to-machine access** via API keys scoped to a project and policy
- **Fine-grained authorization** through policy-based permission checks per project

## Authentication

### Users (JWT)

Users authenticate via `POST /api/v1/users/login` with their username and password. On success, a signed JWT is returned. Include it as a Bearer token on subsequent requests:

```
Authorization: Bearer <jwt>
```

Tokens are valid for 7 days.

### API Keys

API keys provide long-lived credentials for machine-to-machine access. A raw key is returned only once at creation — it is immediately hashed (bcrypt) and cannot be retrieved again.

Key format: `sk_<random>` (e.g., `sk_abc12345xyz`)

Include it as a Bearer token:

```
Authorization: Bearer sk_abc12345xyz
```

An API key is scoped to a specific **Project** and **Policy**. When authenticated via an API key, the system resolves the project context and the key's effective permissions automatically.

**Permission boundary**: An API key's effective permissions are bounded by the membership policy of the user who created it. Even if the key's policy grants broader access, permissions are intersected with the creator's membership policy at authorization time.

## Roles

The IAM module uses a simple role model:

| Role    | Description                                                             |
| ------- | ----------------------------------------------------------------------- |
| `admin` | Full access to all resources and projects. Policy checks are bypassed.  |
| `user`  | Access is scoped to projects they are members of, governed by a policy. |

The first user in the system is bootstrapped as `admin` via `POST /api/v1/users/bootstrap`. Subsequent users are created as `user` by default.

## Projects

A project is the top-level resource boundary. All access control (policies, members, API keys) is scoped to a project.

- Admins can create, list, view, and delete any project.
- Users can only list and view projects they are members of.

## Policies

A policy defines what actions are allowed or denied within a project. Policies are attached to project members and API keys.

| Field            | Type       | Description                                            |
| ---------------- | ---------- | ------------------------------------------------------ |
| `id`             | `string`   | ID (prefix: `pol_`)                                    |
| `name`           | `string`   | Human-readable policy name                             |
| `permissions`    | `string[]` | List of allowed action patterns                        |
| `notPermissions` | `string[]` | List of denied action patterns (deny takes precedence) |
| `projectId`      | `string`   | The project this policy belongs to                     |

### Permission Patterns

Permission strings follow the format `resource:action`. Wildcards are supported:

| Pattern         | Matches                            |
| --------------- | ---------------------------------- |
| `files:*`       | Any action on the `files` resource |
| `*`             | Any action on any resource         |
| `files:GetFile` | Exactly the `files:GetFile` action |

### Authorization Logic

For a `user` role, a request is allowed if **all** of the following hold:

1. The user is a member of the project being accessed.
2. The user's membership policy **allows** the action (`permissions` match).
3. The user's membership policy does **not deny** the action (`notPermissions` do not match).
4. If the request uses an API key, the key's policy also allows the action (intersection).

`admin` users bypass all policy checks.

## Project Members

A project member is a user who has been granted access to a project under a specific policy.

- Only admins can add, update, or remove members.
- Removing a member revokes their access to the project immediately.

## API Keys

| Field       | Type     | Description                                                |
| ----------- | -------- | ---------------------------------------------------------- |
| `id`        | `string` | Public ID (prefix: `key_`)                                 |
| `name`      | `string` | Human-readable key name                                    |
| `policyId`  | `string` | Public ID of the policy governing this key                 |
| `projectId` | `string` | Public ID of the scoped project                            |
| `key`       | `string` | Raw key value — **returned only at creation, never again** |

- Any project member can create an API key scoped to their own project.
- The key's policy must be valid within the same project.
- The key's effective permissions are bounded by the creator's membership policy.
- Members can list and delete their own keys. Admins can manage all keys.

## Data Model

All IAM entities are backed by the `@soat/postgresdb` package and use a `publicId` (prefixed string) as the external identifier. Internal integer primary keys are never exposed through the API.

| Entity  | `publicId` Prefix |
| ------- | ----------------- |
| User    | `usr_`            |
| Project | `proj_`           |
| Policy  | `pol_`            |
| API Key | `key_`            |

## OAuth

> **Coming soon.** OAuth 2.0 integration is planned for an upcoming release. Supported flows will include Authorization Code (interactive sign-in) and Client Credentials (server-to-server).
