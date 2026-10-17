---
description: 'Overview of the SOAT REST API: versioned, authenticated HTTP endpoints that return JSON for every platform operation.'
sidebar_label: Overview
sidebar_position: 1
slug: /api
---

# REST API Reference

## Base URL

```
https://your-soat-server.com
```

For development, `http://localhost:3000`.

## Authentication

### User Authentication (JWT Bearer Token)

```bash
# 1. Bootstrap the first admin user
curl -X POST https://your-soat-server.com/api/v1/users/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "supersecret"}'

# 2. Login to get a token
curl -X POST https://your-soat-server.com/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "supersecret"}'
# Response: {"token": "eyJhbGc..."}

# 3. Use the token in requests
curl https://your-soat-server.com/api/v1/users \
  -H "Authorization: Bearer eyJhbGc..."
```

JWT tokens expire after 7 days.

### Project Key Authentication

```bash
# Create a project key (requires user authentication first)
curl -X POST https://your-soat-server.com/api/v1/project-keys \
  -H "Authorization: Bearer <user-token>" \
  -H "Content-Type: application/json" \
  -d '{"projectPublicId": "proj_xyz", "policyIds": [1]}'
# Response: {"id": "sk_...", "secret": "sk_..."}

# Use the key in requests (set the full "ID" string as bearer token)
curl https://your-soat-server.com/api/v1/projects/proj_xyz/files \
  -H "Authorization: Bearer sk_..."
```

Project keys inherit the associated policy's permissions.

## Common Patterns

### Error Responses

Errors return a 4xx or 5xx status with a structured body:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Project 'proj_abc123' not found.",
    "hint": "Check the id, and check that the credential can see the project that owns the resource — a resource in another project is indistinguishable from one that does not exist. List the collection to confirm.",
    "docs_url": "https://soat.ttoss.dev/docs/error-codes#resource_not_found",
    "meta": { "id": "proj_abc123" }
  }
}
```

`code` is stable and safe to branch on; `message` describes this occurrence;
`hint` says what to do; `docs_url` points at that code's section on the
[Error Codes](/docs/error-codes) page; `meta` is optional, present only for
some codes.

**Every** error response uses this shape (`error` is always an object with a
`code` and a `message`), including:

| Situation                                 | Status | Body                                                                                   |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| Missing or invalid credentials            | `401`  | `code: "UNAUTHORIZED"`, `message: "Unauthorized"`                   |
| Insufficient permissions                  | `403`  | `code: "FORBIDDEN"`, `message: "Forbidden"`                         |
| Unparseable request body                  | `400`  | `code: "VALIDATION_FAILED"`, `message: "Malformed request body: …"` |
| Rejected by the HTTP layer before routing | varies | `code: "REQUEST_REJECTED"`                          |
| Unhandled server failure                  | `500`  | `code: "INTERNAL_ERROR"`, `message: "Internal Server Error"`        |

Each also carries `hint` and `docs_url`.

The full catalog (every `error.code`, its HTTP status, meaning and remedy) is
generated from the server source and published at [/errors.json](/errors.json),
as the `x-error-codes` extension of [/openapi.json](/openapi.json), and on the
[Error Codes](/docs/error-codes) page. `INTERNAL_ERROR` always carries exactly
that message; the underlying exception is logged server-side, never forwarded.

Work that fails after its request has answered — an orchestration run or node,
a trigger firing, a decision, a playbook execution or export — records the same
shape in its `error` field: `{ code, message, meta? }`. A failure the platform
names keeps its code, message and `meta`; any other records `INTERNAL_ERROR`
with the same constant message, and its detail reaches the server log only.

Common status codes:

- **200** — Success
- **201** — Created
- **400** — Bad Request (invalid parameters)
- **401** — Unauthorized (missing or invalid token)
- **403** — Forbidden (insufficient permissions)
- **404** — Not Found
- **409** — Conflict (e.g., duplicate resource)
- **500** — Internal Server Error

### Pagination

**Every** `GET` list endpoint returns the same envelope and accepts
`limit`/`offset`:

```jsonc
{
  "data": [/* the page of resources */],
  "total": 128, // total rows matching the query, across all pages
  "limit": 50, // the effective page size applied
  "offset": 0, // the offset this page started at
}
```

```bash
curl 'https://your-soat-server.com/api/v1/agents?project_id=proj_abc&limit=25&offset=0' \
  -H "Authorization: Bearer <token>"
```

- `limit` — results per page. Default `50`, clamped to `100`: a larger value is capped, and `limit` in the response reports the page served. The [audit log](../modules/audit-log.md) defaults to `25` and caps at `200`.
- `offset` — results to skip (default `0`).
- A `limit` that is not an integer of at least `1`, or an `offset` that is not a non-negative integer (`abc`, `1.5`, `0`, `-1`), is `400 VALIDATION_FAILED`.
- Items are in `response.data`, never the top-level body.
- No `cursor`, `page`, or `sort`/`order` parameter. Sort order is fixed per endpoint (see the module doc), and rows that tie on it are broken by creation order, so a tie never reorders between pages.

The server enforces no per-project or per-API-key request-rate limits or throttling; every authenticated request is processed immediately, bounded only by the limits above and the [1 MiB inbound webhook body cap](../modules/triggers.md#inbound-webhook-endpoint).

### List Filters

Every list filter takes one shape:

- **Status** — a `status` (or `*_status`) filter repeats, and its values are ORed. One value is the common case; a value outside the enum, empty string included, is `400 VALIDATION_FAILED`.
- **Time range** — `from` / `to`, ISO 8601, on the record's natural timestamp (`created_at` unless the module doc says otherwise). A range over another timestamp prefixes the field: `expires_from` / `expires_to` on [approvals](../modules/approvals.md) bound `expires_at`. Both ends are inclusive and either may be omitted; an unparseable or repeated bound is `400 VALIDATION_FAILED`.

```bash
curl 'https://your-soat-server.com/api/v1/generations?status=failed&status=requires_action' \
  -H "Authorization: Bearer <token>"
curl 'https://your-soat-server.com/api/v1/audit-log?project_id=proj_abc&from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z' \
  -H "Authorization: Bearer <token>"
```

### Path and Query Parameters

```bash
# Path parameter: file ID in the URL
GET /api/v1/files/{id}
curl https://your-soat-server.com/api/v1/files/file_abc123

# Query parameters: appended to the URL
GET /api/v1/files?projectPublicId=proj_123&limit=10
curl 'https://your-soat-server.com/api/v1/files?projectPublicId=proj_123&limit=10'
```

### Request Body

`POST` and `PUT` bodies are JSON with `Content-Type: application/json`:

```bash
curl -X POST https://your-soat-server.com/api/v1/files \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "report.pdf",
    "projectPublicId": "proj_123"
  }'
```

File uploads use `multipart/form-data`:

```bash
curl -X POST https://your-soat-server.com/api/v1/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@report.pdf" \
  -F "projectPublicId=proj_123"
```

## Modules

| Module                                                      | Description                                  |
| ----------------------------------------------------------- | -------------------------------------------- |
| [Users](/docs/api/users/list-users)                         | User accounts, authentication, and bootstrap |
| [Projects](/docs/api/projects/create-project)               | Projects, membership, and access control     |
| [API Keys](/docs/api/api-keys/create-api-key)               | API keys scoped to projects                  |
| [Secrets](/docs/api/secrets/list-secrets)                   | Encrypted project secrets                    |
| [Files](/docs/api/files/list-files)                         | File storage and retrieval                   |
| [Documents](/docs/api/documents/list-documents)             | Document management and processing           |
| [Conversations](/docs/api/conversations/list-conversations) | Conversation sessions and state              |
| [Chats](/docs/api/chats/list-chats)                         | Real-time messaging and AI interactions      |
| [Agents](/docs/api/agents/list-agents)                      | Autonomous agents and tool execution         |
| [Webhooks](/docs/api/webhooks/list-webhooks)                | Event subscriptions and deliveries           |
| [AI Providers](/docs/api/ai-providers/list-ai-providers)    | LLM provider configuration                   |

## TypeScript SDK

[`@soat/sdk`](/docs/sdk) wraps the REST API with typing:

```ts
import { createSoatClient } from '@soat/sdk';

const soat = createSoatClient({
  baseUrl: 'https://your-soat-server.com',
  token: 'your-bearer-token',
});

const { data: page } = await soat.GET('/api/v1/files', {
  params: { query: { projectPublicId: 'proj_123' } },
});
// List endpoints return the paginated envelope:
const files = page?.data;
```

## OpenAPI Specification

```
GET https://your-soat-server.com/openapi.yaml
```

OpenAPI 3.1; use it to generate clients in any language.
