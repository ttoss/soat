---
description: 'Your own OAuth 2.0 apps at third-party providers, which SOAT actors connect through.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# OAuth Clients

Your own OAuth 2.0 apps at third-party providers (X, Google, GitHub, …), which [actors](./actors.md) connect through with [OAuth connections](./oauth-connections.md).

## Overview

An OAuth client belongs to a project and holds what the provider issued you when you registered the app: its endpoints, `client_id` and a [secret reference](./secrets.md#secret-references-secret) to its client secret. The app is yours: its name is the one on the provider's consent screen, and provider verifications (such as Google's restricted scopes) are yours to obtain.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field                        | Type           | Description                                                                                                              |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | string         | Public identifier (e.g. `oauc_…`)                                                                                        |
| `project_id`                 | string         | ID of the owning project                                                                                                 |
| `name`                       | string         | Label, such as the provider's name                                                                                       |
| `authorize_url`              | string         | The provider's authorization endpoint; query parameters it already carries are kept                                      |
| `token_url`                  | string         | The provider's token endpoint                                                                                            |
| `revocation_url`             | string \| null | RFC 7009 revocation endpoint, called when a connection is deleted                                                        |
| `client_id`                  | string         | Your app's client ID                                                                                                     |
| `client_secret`              | string \| null | `{{secret:sec_…}}` reference to the client secret; `null` for a public client                                            |
| `scopes`                     | string[]       | Scopes requested at authorization                                                                                        |
| `pkce`                       | boolean        | Whether authorization uses PKCE `S256` (default `true`)                                                                  |
| `token_endpoint_auth_method` | string         | `client_secret_basic` (default) or `client_secret_post`                                                                  |
| `redirect_uri`               | string \| null | The callback registered with the provider; `null` is `{SOAT_BASE_URL}/api/v1/oauth-connections/callback`                 |
| `authorize_params`           | object \| null | Extra authorize URL parameters, such as Google's `{ "access_type": "offline", "prompt": "consent" }` for a refresh token |
| `created_at`                 | string         | ISO 8601 creation timestamp                                                                                              |
| `updated_at`                 | string         | ISO 8601 last-updated timestamp                                                                                          |

## Key Concepts

### The client secret is a reference

`client_secret` takes only a secret reference; a literal is `400 VALIDATION_FAILED`. Writing one needs `secrets:UseSecret` on the secret, else `403 FORBIDDEN`. The reference is what `GET` returns.

### Redirect URI

Register `redirect_uri` with the provider. Left `null`, it is this server's own callback, which needs `SOAT_BASE_URL`. A front end that receives the provider's redirect itself (its own domain on the consent screen) forwards `code` and `state` to [`GET /api/v1/oauth-connections/callback`](/docs/api/oauth-connections/complete-oauth-connection).

### Deletion

Deleting a client deletes every connection made through it, without revoking them at the provider; delete the connections first to revoke.

## Examples

### Create a client for X

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-oauth-client --project-id proj_ABC --name x \
  --authorize-url https://x.com/i/oauth2/authorize \
  --token-url https://api.x.com/2/oauth2/token \
  --revocation-url https://api.x.com/2/oauth2/revoke \
  --client-id Tm9ZWdEX2hQ \
  --client-secret '{{secret:sec_01}}' \
  --scopes '["tweet.read","users.read","offline.access"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.oauthClients.createOauthClient({
  body: {
    project_id: 'proj_ABC',
    name: 'x',
    authorize_url: 'https://x.com/i/oauth2/authorize',
    token_url: 'https://api.x.com/2/oauth2/token',
    revocation_url: 'https://api.x.com/2/oauth2/revoke',
    client_id: 'Tm9ZWdEX2hQ',
    client_secret: '{{secret:sec_01}}',
    scopes: ['tweet.read', 'users.read', 'offline.access'],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/oauth-clients \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_ABC", "name": "x", "authorize_url": "https://x.com/i/oauth2/authorize", "token_url": "https://api.x.com/2/oauth2/token", "revocation_url": "https://api.x.com/2/oauth2/revoke", "client_id": "Tm9ZWdEX2hQ", "client_secret": "{{secret:sec_01}}", "scopes": ["tweet.read", "users.read", "offline.access"]}'
```

</TabItem>
</Tabs>
