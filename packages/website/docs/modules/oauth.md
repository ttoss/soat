---
description: "SOAT as a first-party OAuth 2.1 Authorization Server for its MCP endpoint."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# OAuth

SOAT is a first-party **OAuth 2.1 Authorization Server** for its MCP endpoint.
MCP clients (Claude, Cursor, VS Code) discover the server, register
dynamically, run the authorize + PKCE flow against a SOAT-hosted **consent
screen**, and receive an access token scoped to a single project and a chosen
set of permissions.

The protocol mechanics (discovery, Dynamic Client Registration, PKCE, token
grants) are provided by [`@ttoss/http-server-auth`](https://ttoss.dev) and
[`@ttoss/auth-core`](https://ttoss.dev). SOAT owns three hooks — token minting,
consent, and refresh validation — plus the consent screen.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Discovery endpoints

An OAuth-aware client is never told these paths — it finds them. Point it at the
deployment's base URL and it fetches the metadata below, reads the endpoints out
of it, registers itself, and runs the flow. Nothing here needs an operator step.

| Path | Spec | What it answers |
|---|---|---|
| [`GET /.well-known/oauth-authorization-server`](/docs/api/oauth/get-oauth-authorization-server-metadata) | [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) | Where `/authorize`, `/token` and `/register` are, which grants and PKCE methods are supported, and which scopes exist |
| [`GET /.well-known/oauth-protected-resource`](/docs/api/oauth/get-oauth-protected-resource-metadata) | [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) | That `/mcp` is a protected resource, and which authorization server guards it |
| [`POST /register`](/docs/api/oauth/register-oauth-client) | [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) | Dynamic Client Registration — the client mints its own `client_id` |
| [`GET /authorize`](/docs/api/oauth/authorize-oauth-client) | OAuth 2.1 | Authorization request; redirects to the consent screen when no grant exists |
| [`POST /token`](/docs/api/oauth/create-oauth-token) | OAuth 2.1 | Authorization-code (PKCE) and refresh-token grants |

All five are served by the server itself, unauthenticated where the protocol
requires it — a client that needed a token to discover where tokens come from
could never start.

They are also declared in the published OpenAPI description
([`/openapi.json`](https://soat.ttoss.dev/openapi.json)), so a client that has
no deployment to probe can still read the flow — the request and response shapes
above are the reference pages linked in the table. Because their paths are fixed
by the RFCs and sit outside `/api/v1`, they are deliberately **not** wrapped by
the generated SDK, CLI, or MCP tool surface: `/authorize` is a browser redirect
and `/token` takes a form-encoded body, so a generated caller for either would
be broken rather than merely unused. Unlike the REST API, these endpoints answer
errors in the RFC 6749 shape (`{ error, error_description }`) rather than SOAT's
`{ code, message, hint, docs_url }`, because an OAuth client branches on
`error`.

```bash
curl -s http://localhost:5047/.well-known/oauth-authorization-server | jq
```

```json
{
  "issuer": "http://localhost:5047",
  "authorization_endpoint": "http://localhost:5047/authorize",
  "token_endpoint": "http://localhost:5047/token",
  "registration_endpoint": "http://localhost:5047/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": [
    "client_secret_basic",
    "client_secret_post",
    "none"
  ],
  "scopes_supported": ["mcp:access"]
}
```

The `issuer` — and therefore every advertised endpoint — comes from
`SOAT_BASE_URL`. A deployment that leaves it unset advertises `localhost`, which
a remote client cannot reach; see [Configuration](#configuration).

`code_challenge_methods_supported` is `["S256"]` only. PKCE is mandatory in
OAuth 2.1, and `plain` is deliberately not offered.

## Flow

```mermaid
flowchart TB
    S1["MCP client<br/>GET /authorize"]
    S2["Authorization Server<br/>no consent cookie<br/>302 → /app/oauth/consent"]
    S3["Consent screen (app/SPA)<br/>user signs in if needed,<br/>picks a project + permissions"]
    S4["Consent screen → Auth Server<br/>POST /api/v1/oauth/consent<br/>bearer token + authorize_query"]
    S5["Authorization Server<br/>sets single-use consent cookie,<br/>returns authorize_url"]
    S6["App navigates → GET /authorize<br/>server issues code to the client"]
    S7["MCP client → POST /token<br/>access token (JWT)"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7
```

Login is handled by the app (the SPA): `/authorize` redirects the browser to
the consent screen at `/app/oauth/consent`, where the app's normal sign-in
applies. The consent screen then calls the JSON API below with the user's
bearer token. The server never renders a login or consent page itself.

## Consent screen

The consent screen lives in the app (`packages/app`, `src/oauth/consentView.tsx`).
It lets the user choose **one project** and grant permissions at three levels
of granularity:

| Tier | Control | Resulting scope |
|---|---|---|
| **All** | "Grant all permissions" toggle | `*` |
| **Module** (intermediary) | per-module checkbox (selects every action of that module) | `<module>:*` |
| **Granular** | individual action checkboxes | `<module>:<Action>` |

The permission catalog rendered on the screen is derived from
`packages/server/src/permissions/*.json`, so it stays in sync with the actual
API actions automatically.

Whatever the tier, the grant is always scoped to the chosen project via the SRN
`srn:<project_id>:*:*`. The selection is carried by the issued token as its
`scope` claim and reconstructed into an IAM [policy document](./policies.md) on
every request — see [Permission enforcement](#permission-enforcement).

## Permission enforcement

An OAuth access token is a **scoped credential**, authorized by the same IAM
evaluator as [API keys](./api-keys.md#permission-inheritance). On each request
the server rebuilds the consent policy from the token's `scope` claim (stripping
the synthetic `mcp:access` and `prj:<id>` markers) and evaluates the
**intersection** of:

1. the owning user's policies (the ceiling — the token can never exceed them, not
   even for an admin), and
2. the consented scope (restricting to the actions the user approved, within the
   single `srn:<project_id>:*:*` resource).

Both must independently allow an action. A token whose consent carried no action
scopes therefore grants nothing, and the `prj` claim hard-locks every request to
the consented project.

## Design: one project per token

A SOAT access token is scoped to exactly **one** project. The consent screen
offers a single-project selector, `/api/v1/oauth/consent` accepts a single
`project_id`, and the issued JWT carries a single `prj` claim backed by one
IAM resource (`srn:<project_id>:*:*`). This is a deliberate design choice, not
a limitation to work around.

### Why

- **Project scope is ambient for the agent.** The server resolves the project
  from the token, so MCP tool calls never carry a `project_id` argument the
  model could get wrong.
- **Minimal blast radius.** A leaked token can never reach beyond the one
  consented project, and the resulting policy is trivial to audit.
- **Comprehensible consent.** "Grant this client access to *Project X* with
  these permissions" is a claim a user can evaluate at a glance.

### Working across multiple projects

Run the consent flow once per project and configure the MCP client with a
separate server entry per token (most MCP clients support multiple named
servers). Re-running the short consent flow mints a token for a different
project; the prior token is unaffected.

## Data model

OAuth is not a CRUD resource — it exposes two bearer-authenticated JSON
operations that back the consent screen. Their API-facing fields are below.

### Consent info (response)

Data used to render the consent screen.

| Field      | Type     | Description                                                        |
|------------|----------|--------------------------------------------------------------------|
| `projects` | object[] | Projects the caller can grant access to (`id`, `name` each)        |
| `modules`  | object[] | Permission catalog — modules and their granular actions           |

### Consent decision (request)

| Field             | Type   | Required | Description                                                                 |
|-------------------|--------|----------|-----------------------------------------------------------------------------|
| `project_id`      | string | Yes      | The single project the grant is scoped to                                   |
| `selection`       | object | Yes      | Chosen permissions: `{ kind: "all" }`, `{ kind: "modules", modules }`, or `{ kind: "actions", actions }` |
| `authorize_query` | string | No       | The original OAuth `/authorize` query string; when present, completes the flow |

### Consent decision (response)

| Field           | Type     | Description                                                                    |
|-----------------|----------|--------------------------------------------------------------------------------|
| `project_id`    | string   | The project the grant is scoped to                                             |
| `scopes`        | string[] | Granted permission scopes                                                      |
| `policy`        | object   | The project-scoped IAM [policy document](./policies.md) the token would carry  |
| `authorize_url` | string   | Present only when `authorize_query` was supplied — URL for the app to navigate back to |

Registered clients, authorization codes, and consent grants are held in
single-use, short-lived server-side stores backing the protocol flow above; they
are not exposed through the API.

## Access token

The access token is an HS256 JWT (`@ttoss/auth-core` `signJwt`) carrying:

- `sub` — the SOAT user's public id
- `scope` — space-separated granted scopes, plus `mcp:access` and a
  `prj:<project_id>` marker
- `prj` — the granted project's public id

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOAT_BASE_URL` | `http://localhost:<PORT>` | OAuth issuer / resource identifier advertised in discovery metadata |
| `JWT_SECRET` | `dev-secret` | HS256 signing secret for issued access tokens |

## Examples

The OAuth flow is driven by MCP clients and the in-app consent screen, so its
JSON operations are **not exposed through the CLI or SDK**. They are called with
a user bearer token; the examples below use `curl`.

### Fetch consent-screen data

Returns the projects the caller can grant and the permission catalog.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

No CLI command — the consent screen is rendered by the app, not the CLI.

</TabItem>
<TabItem value="sdk" label="SDK">

No SDK method — this endpoint backs the app consent screen and is not part of the generated SDK surface.

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/oauth/consent-info \
  -H "Authorization: Bearer <user-token>"
```

</TabItem>
</Tabs>

### Record a consent decision

Resolves a project + permission selection into scopes and a project-scoped IAM
policy. Include `authorize_query` to complete an in-flight `/authorize` request.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

No CLI command — consent is submitted by the app on the user's behalf.

</TabItem>
<TabItem value="sdk" label="SDK">

No SDK method — consent is submitted by the app on the user's behalf.

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/oauth/consent \
  -H "Authorization: Bearer <user-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "selection": { "kind": "modules", "modules": ["agents", "sessions"] }
  }'
```

</TabItem>
</Tabs>
