---
sidebar_position: 1
slug: /sdk
---

# SOAT SDK

The `@soat/sdk` package is a typed TypeScript client for the SOAT REST API, generated directly from the OpenAPI specs. Every endpoint, parameter, and response body is fully typed.

## Installation

```bash
npm install @soat/sdk
# or
pnpm add @soat/sdk
```

## Setup — `SoatClient` (recommended)

Create a `SoatClient` instance once and reuse it throughout your application. Resources are exposed as properties on the instance — no need to pass a `client` on every call:

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({
  baseUrl: 'https://your-soat-server.com/api/v1',
  token: 'your-bearer-token',
});
```

| Option    | Type                     | Required | Description                                                        |
| --------- | ------------------------ | -------- | ------------------------------------------------------------------ |
| `baseUrl` | `string`                 | No       | Base URL including `/api/v1`. Defaults to `/api/v1` (same-origin). |
| `token`   | `string`                 | No       | Bearer token — JWT session token or `sk_`-prefixed project key.    |
| `headers` | `Record<string, string>` | No       | Additional headers merged into every request.                      |

## Calling Methods

Each SOAT resource has a corresponding property on `SoatClient` (e.g., `soat.actors`, `soat.users`, `soat.files`). Call methods directly — they have the same signatures as the static service classes:

```ts
const { data, error } = await soat.actors.listActors();
```

Parameters are passed as named fields on the options object:

| Field   | When to use                   | Example                             |
| ------- | ----------------------------- | ----------------------------------- |
| `path`  | URL path parameters           | `path: { actor_id: 'act_...' }`     |
| `query` | Query string parameters       | `query: { limit: 10 }`              |
| `body`  | Request body (POST/PUT/PATCH) | `body: { name: 'Bot', type: 'ai' }` |

Body and query fields use the REST field names. Path parameters also use the exact resource-specific names from the URL template, such as `actor_id`, `project_id`, `file_id`, and `conversation_id`.

```ts
// Path param
const { data } = await soat.actors.getActor({
  path: { actor_id: 'act_...' },
});

// POST with body (fields use snake_case)
const { data } = await soat.actors.createActor({
  body: { name: 'Support Bot', type: 'ai' },
});
```

## Error Handling

Every call returns `{ data, error, response }`. Always check `error` before using `data`:

```ts
const { data, error } = await soat.users.listUsers();

if (error) {
  throw new Error(`API error: ${JSON.stringify(error)}`);
}

console.log(data); // fully typed
```

When `error` is set, `data` is `undefined`. Use early returns or throws to guard before accessing `data`.

## Authentication

SOAT accepts two token types as the `token` option:

- **JWT session token** — obtained from `POST /api/v1/users/login`
- **Project-scoped API key** — prefixed `sk_`, obtained from `POST /api/v1/project-keys`

```ts
// JWT token
const soat = new SoatClient({ baseUrl, token: sessionToken });

// Project key
const soat = new SoatClient({ baseUrl, token: 'sk_...' });
```

## Low-level API — Static Service Classes

The underlying generated static classes (`Actors`, `Users`, `Files`, etc.) are also exported. These require you to pass a `client` instance on every call and are useful for advanced use cases such as per-request auth overrides or custom fetch implementations:

```ts
import { Actors, createClient, createConfig } from '@soat/sdk';

const client = createClient(
  createConfig({
    baseUrl: 'https://your-soat-server.com/api/v1',
    headers: { Authorization: 'Bearer sk_...' },
  })
);

const { data, error } = await Actors.listActors({ client });
```

See the [Services Reference](./services.md) for the full list of static class methods.
