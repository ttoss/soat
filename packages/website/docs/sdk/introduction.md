---
description: "The @soat/sdk typed TypeScript client for the SOAT REST API, generated from the OpenAPI specs."
sidebar_position: 1
slug: /sdk
---

# SOAT SDK

`@soat/sdk` is a TypeScript client for the SOAT REST API, generated from the OpenAPI specs; every endpoint, parameter, and response body is typed.

## Installation

```bash
npm install @soat/sdk
# or
pnpm add @soat/sdk
```

## Setup — `SoatClient` (recommended)

Create one `SoatClient` and reuse it:

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({
  baseUrl: 'https://your-soat-server.com',
  token: 'your-bearer-token',
});
```

| Option    | Type                     | Required | Description                                                                          |
| --------- | ------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `baseUrl` | `string`                 | No       | Server base URL (e.g. `https://api.example.com`). Defaults to the current origin.   |
| `token`   | `string`                 | No       | Bearer token — JWT session token or `sk_`-prefixed API key.                          |
| `headers` | `Record<string, string>` | No       | Additional headers merged into every request.                                        |

## Calling Methods

Each resource is a property on `SoatClient` (`soat.actors`, `soat.users`, `soat.files`):

```ts
const { data, error } = await soat.actors.listActors();
```

| Field   | When to use                   | Example                             |
| ------- | ----------------------------- | ----------------------------------- |
| `path`  | URL path parameters           | `path: { actor_id: 'actor_...' }`   |
| `query` | Query string parameters       | `query: { limit: 10 }`              |
| `body`  | Request body (POST/PUT/PATCH) | `body: { name: 'Bot', type: 'ai' }` |

Body and query fields use the REST field names; path parameters use the URL template's names (`actor_id`, `project_id`, `file_id`, `conversation_id`):

```ts
// Path param
const { data } = await soat.actors.getActor({
  path: { actor_id: 'actor_...' },
});

// POST with body (fields use snake_case)
const { data } = await soat.actors.createActor({
  body: { name: 'Support Bot', external_id: '+15551234567' },
});
```

## Error Handling

Every call returns `{ data, error, response }`; when `error` is set, `data` is `undefined`:

```ts
const { data, error } = await soat.users.listUsers();

if (error) {
  throw new Error(`API error: ${JSON.stringify(error)}`);
}

console.log(data); // fully typed
```

## Authentication

- **JWT session token** — obtained from [`POST /api/v1/users/login`](/docs/api/users/login-user)
- **API key** — prefixed `sk_`, obtained from [`POST /api/v1/api-keys`](/docs/api/api-keys/create-api-key)

```ts
// JWT token
const soat = new SoatClient({ baseUrl, token: sessionToken });

// API key
const soat = new SoatClient({ baseUrl, token: 'sk_...' });
```

## Low-level API — Static Service Classes

The generated static classes (`Actors`, `Users`, `Files`, etc.) take a `client` on every call, for per-request auth overrides or custom fetch implementations:

```ts
import { Actors, createClient, createConfig } from '@soat/sdk';

const client = createClient(
  createConfig({
    baseUrl: 'https://your-soat-server.com',
    headers: { Authorization: 'Bearer sk_...' },
  })
);

const { data, error } = await Actors.listActors({ client });
```

Full method list: [Services Reference](./services.md).
