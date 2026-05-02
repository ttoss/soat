import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Users

The Users module manages human identities within SOAT. A user can authenticate via username/password and receive a JWT token used for subsequent requests.

## Overview

Users are global to the SOAT instance (not scoped to a project). The first user is created via the bootstrap endpoint. After that, only authenticated admin users may create additional users.

Users can have [Policies](./policies.md) attached to them, which control what resources and operations they are permitted to access.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field        | Type   | Description                      |
| ------------ | ------ | -------------------------------- |
| `id`         | string | Public identifier (e.g. `usr_…`) |
| `username`   | string | Unique login name                |
| `created_at` | string | ISO 8601 creation timestamp      |
| `updated_at` | string | ISO 8601 last-updated timestamp  |

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
// SDK
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
// SDK
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
// SDK
const authedSoat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

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
