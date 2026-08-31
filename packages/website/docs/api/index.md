---
description: 'Overview of the SOAT REST API: versioned, authenticated HTTP endpoints that return JSON for every platform operation.'
sidebar_label: Overview
sidebar_position: 1
slug: /api
---

# REST API Reference

The SOAT REST API provides standard HTTP endpoints for all platform operations. Every endpoint is versioned, authenticated, and returns JSON responses.

## Base URL

```
https://your-soat-server.com
```

Replace `your-soat-server.com` with your SOAT instance URL. For development, use `http://localhost:3000`.

## Authentication

The API supports two authentication methods:

### User Authentication (JWT Bearer Token)

For user accounts, authenticate using JWT bearer tokens obtained after login:

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

For programmatic access to a specific project, use API keys (project keys). Create a project key through the API, then authenticate requests with it:

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

Project keys are scoped to a single project and inherit permissions from the associated policy.

## Common Patterns

### Error Responses

All errors return a 4xx or 5xx status code. Most business-logic errors use a structured shape with a stable `code`:

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

`code` is stable and safe to branch on; `message` describes this occurrence.
`hint` says what to do about the failure, and `docs_url` addresses the section
for that code on the [Error Codes](/docs/error-codes) page — together they mean a
caller meeting a code for the first time can act without leaving the response.
`meta` is optional and present only for some error codes.

**Every** error response uses this shape, with no exceptions — `error` is always
an object with a `code` and a `message`, so a client can read `error.code`
without first testing what it got. That includes the responses most likely to be
special-cased:

| Situation                                 | Status | Body                                                                                   |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| Missing or invalid credentials            | `401`  | `code: "UNAUTHORIZED"`, `message: "Unauthorized"`                   |
| Insufficient permissions                  | `403`  | `code: "FORBIDDEN"`, `message: "Forbidden"`                         |
| Unparseable request body                  | `400`  | `code: "VALIDATION_FAILED"`, `message: "Malformed request body: …"` |
| Rejected by the HTTP layer before routing | varies | `code: "REQUEST_REJECTED"`                          |
| Unhandled server failure                  | `500`  | `code: "INTERNAL_ERROR"`, `message: "Internal Server Error"`        |

Each of these carries its own `hint` and `docs_url` as well; only `code` and
`message` are shown above.

The full catalog of codes — every `error.code` the API can return, with its HTTP
status, what it means, and what to do about it — is published as JSON at
[/errors.json](/errors.json), as the `x-error-codes` extension of
[/openapi.json](/openapi.json), and as a page at
[Error Codes](/docs/error-codes). All three are generated from the server
source, so a client can branch on codes without scraping this page.

`INTERNAL_ERROR` always carries exactly that message: the underlying exception is
logged server-side and never forwarded to the client, so the body carries no
detail to act on beyond retrying.

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

**Every** `GET` list endpoint returns the same paginated envelope and accepts
`limit`/`offset` query parameters:

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

- `limit` — Number of results per page. Defaults to `50` and is clamped to a maximum of `100`; a larger requested `limit` is capped, not rejected.
- `offset` — Number of results to skip (default `0`).
- Every list endpoint answers with `{ data, total, limit, offset }` — read the items from `response.data`, never the top-level body.
- There is no `cursor`, `page`, or `sort`/`order` query parameter on any endpoint. Sort order (when defined) is fixed per endpoint — check that resource's module doc — and is not client-configurable.

There are currently no per-project or per-API-key request-rate limits, quotas, or throttling enforced by the server — every authenticated request is processed immediately, bounded only by the resource limits described above and the [1 MiB inbound webhook body cap](../modules/triggers.md#inbound-webhook-endpoint).

### Path and Query Parameters

Path parameters are replaced in the URL; query parameters are appended:

```bash
# Path parameter: file ID in the URL
GET /api/v1/files/{id}
curl https://your-soat-server.com/api/v1/files/file_abc123

# Query parameters: appended to the URL
GET /api/v1/files?projectPublicId=proj_123&limit=10
curl 'https://your-soat-server.com/api/v1/files?projectPublicId=proj_123&limit=10'
```

### Request Body

`POST` and `PUT` requests accept JSON request bodies with `Content-Type: application/json`:

```bash
curl -X POST https://your-soat-server.com/api/v1/files \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "report.pdf",
    "projectPublicId": "proj_123"
  }'
```

File uploads use `multipart/form-data` instead:

```bash
curl -X POST https://your-soat-server.com/api/v1/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@report.pdf" \
  -F "projectPublicId=proj_123"
```

## Modules

The REST API is organized into modules, each covering a specific resource:

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

For TypeScript projects, use the [`@soat/sdk`](/docs/sdk) package to interact with the REST API with full type safety and autocompletion:

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

Every endpoint, parameter, and response schema is fully typed.

## OpenAPI Specification

The REST API is defined in OpenAPI 3.1 format. Download the spec:

```
GET https://your-soat-server.com/openapi.yaml
```

Use this spec to generate clients in any language or integrate with API documentation tools.
