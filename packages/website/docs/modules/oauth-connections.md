---
description: 'Per-actor OAuth 2.0 grants: SOAT runs the authorization, keeps the tokens encrypted, refreshes them, and http tools call the provider as the actor.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# OAuth Connections

One [actor's](./actors.md) grant at a provider through an [OAuth client](./oauth-clients.md). SOAT runs the authorization code flow, keeps the tokens encrypted, refreshes them, and an `http` tool with [`auth.type: oauth_connection`](./tools.md#computed-credentials-executeauth) calls the provider as the actor the turn runs for.

## Overview

1. [`POST /api/v1/oauth-connections`](/docs/api/oauth-connections/create-oauth-connection) with the client and the actor returns an `authorize_url`.
2. Send the person to it. They consent at the provider, which redirects to the callback with `code` and `state`.
3. [`GET /api/v1/oauth-connections/callback`](/docs/api/oauth-connections/complete-oauth-connection) exchanges the code and the connection becomes `connected`.
4. In a [session](./sessions.md) for that actor, or called directly with its `actor_id`, an `http` tool with `auth: { "type": "oauth_connection", "oauth_client_id": "oauc_…" }` sends `Authorization: Bearer <the actor's access token>`.

Tokens are write-only: no route returns them.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field             | Type           | Description                                                     |
| ----------------- | -------------- | --------------------------------------------------------------- |
| `id`              | string         | Public identifier (e.g. `ocon_…`)                               |
| `project_id`      | string         | ID of the owning project                                        |
| `oauth_client_id` | string         | The OAuth client it connects through                            |
| `actor_id`        | string         | The actor the grant is for                                      |
| `status`          | string         | `pending`, `connected` or `disconnected`                        |
| `scopes`          | string[]       | Scopes the provider granted                                     |
| `expires_at`      | string \| null | When the current access token expires                           |
| `connected_at`    | string \| null | When the last authorization completed                           |
| `error`           | object \| null | `{ code, message }` of the last failed authorization or refresh |
| `created_at`      | string         | ISO 8601 creation timestamp                                     |
| `updated_at`      | string         | ISO 8601 last-updated timestamp                                 |

[`POST /api/v1/oauth-connections`](/docs/api/oauth-connections/create-oauth-connection) also returns `authorize_url` and `authorize_url_expires_at`.

## Key Concepts

### One connection per actor and client

Starting again for the same actor and client restarts the same connection (`200` instead of `201`), with a new `authorize_url`. A connected connection keeps its tokens until the new authorization completes.

### The authorization

- `state` is random, single-use and expires after 10 minutes; a replayed, unknown or expired one is `400 OAUTH_CALLBACK_FAILED`.
- PKCE `S256` is used unless the client sets `pkce: false`.
- A refused consent (`error=access_denied`) or a code the token endpoint refuses is `400 OAUTH_CALLBACK_FAILED`, and an unconnected connection becomes `disconnected` with the `error`.
- With `return_url`, the callback redirects there instead, adding `oauth_connection_id` and `status` (`connected` or `failed`) to its query.

Whoever consents at the `authorize_url` connects their account to the actor it was started for: hand it only to that person.

### Using a connection from a tool

The tool sends the token of the connection held by the call's actor: the actor in the turn's [`tool_context`](../advanced/tool-context.md), which the server pins, or the `actor_id` of a direct [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool), which must be an actor of the calling project. A caller never names the actor through `tool_context`. Each call needs `oauth-connections:UseOauthConnection` on the connection (`srn:<project_id>:oauth_connection:<oauth_connection_id>`) from the caller and, in a turn, the agent's [`policy_ids`](./agents.md); `${iam:ActorId}` in a policy condition binds to the turn's actor. A refusal reaches the model as the tool's error, or answers the direct call, and nothing is sent.

A call with no actor, or an actor with no `connected` connection, fails with `TOOL_AUTH_FAILED` (`meta.reason: oauth_connection_required`) telling the actor to reconnect.

### Refresh

An access token within 60 seconds of `expires_at` is refreshed before it is sent. Refreshes take a per-connection lock, so concurrent calls refresh once: providers such as X rotate the refresh token on every use, and a second refresh with the old one would be refused. A refresh the provider refuses (`4xx`) sets the connection `disconnected` with `OAUTH_CONNECTION_REFRESH_FAILED`; a provider that cannot answer (`5xx`, network) fails only that call.

### Deletion

[`DELETE /api/v1/oauth-connections/{oauth_connection_id}`](/docs/api/oauth-connections/delete-oauth-connection) revokes the refresh token (else the access token) at the client's `revocation_url`, then deletes; a failed revocation does not stop the deletion. Deleting the actor or the OAuth client deletes its connections.

## Configuration

| Environment Variable     | Required | Description                                                                                                          |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_ENCRYPTION_KEY` | Yes      | Encrypts the stored tokens and PKCE verifiers, as it does [secrets](./secrets.md#configuration).                     |
| `SOAT_BASE_URL`          | No       | Builds the default callback `{SOAT_BASE_URL}/api/v1/oauth-connections/callback` for a client with no `redirect_uri`. |

## Examples

### Start a connection

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-oauth-connection --oauth-client-id oauc_01 --actor-id actor_01 \
  --return-url https://app.example.com/settings/connections
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.oauthConnections.createOauthConnection({
  body: {
    oauth_client_id: 'oauc_01',
    actor_id: 'actor_01',
    return_url: 'https://app.example.com/settings/connections',
  },
});
if (error) throw new Error(JSON.stringify(error));
// Send the person to data.authorize_url
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/oauth-connections \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"oauth_client_id": "oauc_01", "actor_id": "actor_01", "return_url": "https://app.example.com/settings/connections"}'
```

</TabItem>
</Tabs>

### Call the provider as the actor

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-tool --project-id proj_ABC --name get-my-x-profile --type http \
  --execute '{"url": "https://api.x.com/2/users/me", "method": "GET", "auth": {"type": "oauth_connection", "oauth_client_id": "oauc_01"}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.tools.createTool({
  body: {
    project_id: 'proj_ABC',
    name: 'get-my-x-profile',
    type: 'http',
    execute: {
      url: 'https://api.x.com/2/users/me',
      method: 'GET',
      auth: { type: 'oauth_connection', oauth_client_id: 'oauc_01' },
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/tools \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_ABC", "name": "get-my-x-profile", "type": "http", "execute": {"url": "https://api.x.com/2/users/me", "method": "GET", "auth": {"type": "oauth_connection", "oauth_client_id": "oauc_01"}}}'
```

</TabItem>
</Tabs>

### Call the provider as the actor without a session

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat call-tool --tool-id tool_01 --actor-id actor_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.tools.callTool({
  path: { tool_id: 'tool_01' },
  body: { actor_id: 'actor_01' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/tools/tool_01/call \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"actor_id": "actor_01"}'
```

</TabItem>
</Tabs>
