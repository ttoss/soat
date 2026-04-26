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

## Setup

Import `createClient` and `createConfig` to configure the HTTP client:

```ts
import { createClient, createConfig } from '@soat/sdk';

const client = createClient(
  createConfig({
    baseUrl: 'https://your-soat-server.com',
    auth: 'your-bearer-token',
  })
);
```

| Option    | Type     | Required | Description                                     |
| --------- | -------- | -------- | ----------------------------------------------- |
| `baseUrl` | `string` | Yes      | Base URL of the SOAT server                     |
| `auth`    | `string` | No       | Bearer token — JWT session token or project key |

## Calling Service Methods

Each SOAT resource has a corresponding service class (e.g., `Actors`, `Users`, `Files`). Pass your `client` instance to every call:

```ts
import { Actors } from '@soat/sdk';

const { data, error } = await Actors.listActors({ client });
```

Parameters are passed as named fields on the options object:

| Field   | When to use                   | Example                             |
| ------- | ----------------------------- | ----------------------------------- |
| `path`  | URL path parameters           | `path: { id: 'act_...' }`           |
| `query` | Query string parameters       | `query: { limit: 10 }`              |
| `body`  | Request body (POST/PUT/PATCH) | `body: { name: 'Bot', type: 'ai' }` |

```ts
// Path param
const { data } = await Actors.getActor({ client, path: { id: 'act_...' } });

// POST with body (fields use snake_case)
const { data } = await Actors.createActor({
  client,
  body: { name: 'Support Bot', type: 'ai' },
});
```

## Error Handling

Every call returns `{ data, error, response }`. Always check `error` before using `data`:

```ts
const { data, error } = await Users.listUsers({ client });

if (error) {
  throw new Error(`API error: ${JSON.stringify(error)}`);
}

console.log(data); // fully typed
```

When `error` is set, `data` is `undefined`. Use early returns or throws to guard before accessing `data`.

## Authentication

SOAT accepts two token types as the `auth` value in `createConfig`:

- **JWT session token** — obtained from `POST /api/v1/users/login`
- **Project-scoped API key** — obtained from `POST /api/v1/project-keys` (prefixed `SDK_`)

```ts
// JWT token
const client = createClient(createConfig({ baseUrl, auth: sessionToken }));

// Project key
const client = createClient(createConfig({ baseUrl, auth: 'SDK_...' }));
```
