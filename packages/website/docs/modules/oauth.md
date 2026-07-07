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

## Flow

```
MCP client ──GET /authorize──▶ Authorization Server
                                  │  no consent cookie
                                  ▼
                       302 → /app/oauth/consent   (consent screen in the app/SPA)
                                  │  user signs in (app login) if needed,
                                  │  picks a project + permissions
                                  ▼
                       POST /api/v1/oauth/consent  (bearer token + authorize_query)
                                  │  sets single-use consent cookie,
                                  │  returns authorize_url
                                  ▼
   app navigates → GET /authorize ──▶ issues code ──▶ client
                            client ──POST /token──▶ access token (JWT)
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
`soat:<project_id>:*:*`. The selection is carried by the issued token as its
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
   single `soat:<project_id>:*:*` resource).

Both must independently allow an action. A token whose consent carried no action
scopes therefore grants nothing, and the `prj` claim hard-locks every request to
the consented project.

## Design: one project per token

A SOAT access token is scoped to exactly **one** project. The consent screen
offers a single-project selector, `/api/v1/oauth/consent` accepts a single
`project_id`, and the issued JWT carries a single `prj` claim backed by one
IAM resource (`soat:<project_id>:*:*`). This is a deliberate design choice, not
a limitation to work around.

### Why

- **Project scope is ambient for the agent.** Because the token fixes the
  project, an MCP tool call such as `agents:CreateAgent` does not need to carry
  a `project_id` argument — the server resolves it from the token. A
  multi-project token would force every REST-derived tool to take a project
  argument the model must choose correctly on each call, introducing a class of
  "right action, wrong project" errors.
- **Minimal blast radius.** A single-project token grants access to exactly one
  `soat:<project_id>:*:*` resource. A leaked or over-broad token can never reach
  beyond the project the user consented to, and the resulting policy is trivial
  to audit.
- **Comprehensible consent.** "Grant this client access to *Project X* with
  these permissions" is a claim a user can evaluate at a glance. A per-project ×
  per-module permission matrix is not, and consent screens that are not read are
  not meaningful consent.

### Working across multiple projects

The single-project model does not block multi-project workflows; it scopes each
token to one project rather than generalizing every token:

- **One token per project.** Run the consent flow once per project and configure
  the MCP client with a separate server entry per token (most MCP clients
  support multiple named servers). Each session stays isolated.
- **Switch projects by re-issuing.** Re-running the short consent flow mints a
  token for a different project; the prior token is unaffected.

Generalizing tokens to span multiple projects would touch the consent UI, the
consent endpoint, the [scope builder](./iam.md), and the token's `prj`
claim and policy, while giving up the ambient-scope and blast-radius properties
above. The cost is not justified unless a single agent session must act across
projects without re-authorizing — a need the per-project token model already
covers for the common case.

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
