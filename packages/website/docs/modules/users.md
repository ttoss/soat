---
description: "Human identities within a SOAT instance, authenticated via username and password."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Users

Human identities within the SOAT instance, authenticated via username and password.

## Overview

Users are global, not project-scoped. The first is created via bootstrap; afterwards only admins may create users. Example: [Permissions in Practice — Step 2 (Create regular users)](/docs/tutorials/permissions#step-2--create-regular-users).

Attached [Policies](./policies.md) control access; see [IAM](./iam.md).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Permissions in Practice - Step 2 (Create regular users)](/docs/tutorials/permissions#step-2--create-regular-users)
- [Chat with an LLM - Step 1 (Log in as admin)](/docs/tutorials/chat-with-llm#step-1--log-in-as-admin)
- [Agent with Persistent Memory - Step 1 (Log in as admin)](/docs/tutorials/memories-agent#step-1--log-in-as-admin)

## Data Model

| Field        | Type   | Description                                         |
| ------------ | ------ | --------------------------------------------------- |
| `id`         | string | Public identifier prefixed with `user_`              |
| `username`   | string | Unique login name                                   |
| `role`       | string | `"admin"` or `"user"` — see [Roles](#roles)         |
| `created_at` | string | ISO 8601 creation timestamp                         |
| `updated_at` | string | ISO 8601 last-updated timestamp                     |

Sensitive fields (`passwordHash`, internal numeric ID) are never exposed in responses.

## Key Concepts

### Roles

| Role    | Description                                                              |
| ------- | ------------------------------------------------------------------------ |
| `admin` | Full access to all resources and operations. Bypasses policy evaluation. |
| `user`  | Access determined by the [policies](./policies.md) attached to the account. |

### Bootstrap

The [`POST /api/v1/users/bootstrap`](/docs/api/users/bootstrap-user) creates the first admin user, unauthenticated, only while the user table is empty (`409 Conflict` otherwise). Or bootstrap on startup with:

```env
SOAT_ADMIN_USERNAME=admin
SOAT_ADMIN_PASSWORD=supersecret
```

With both set and no users, the server creates the admin before accepting requests; otherwise they are ignored.

### Authentication

[`POST /api/v1/users/login`](/docs/api/users/login-user) with username and password returns a signed JWT (public ID and role), passed as `Authorization: Bearer <token>`. See [IAM — Authentication](./iam.md#authentication) and [Chat with an LLM — Step 1 (Log in as admin)](/docs/tutorials/chat-with-llm#step-1--log-in-as-admin).

### Policy Attachment

The user-policies endpoint replaces the user's full policy list. User create/delete require the `admin` role and bypass the policy engine.

## Examples

### Bootstrap first user

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat bootstrap-user --username admin --password supersecret
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com' });

const { data, error } = await soat.users.bootstrapUser({
  body: { username: 'admin', password: 'supersecret' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/users/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "supersecret"}'
```

</TabItem>
</Tabs>

### Login

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password supersecret
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.users.loginUser({
  body: { username: 'admin', password: 'supersecret' },
});
if (error) throw new Error(JSON.stringify(error));
// data.token is the JWT to use in subsequent requests
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "supersecret"}'
```

</TabItem>
</Tabs>

### Create an additional user

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-user --username alice --password alicepass
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const authedSoat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await authedSoat.users.createUser({
  body: { username: 'alice', password: 'alicepass' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/users \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "alicepass"}'
```

</TabItem>
</Tabs>
