---
sidebar_label: REST API
sidebar_position: 1
---

# REST API Reference

The SOAT REST API provides standard HTTP endpoints for all platform operations. Every endpoint is versioned, authenticated, and returns JSON responses.

## Base URL

```
https://your-soat-server.com/api/v1
```

Replace `your-soat-server.com` with your SOAT instance URL. For development, use `http://localhost:3000/api/v1`.

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

All errors return a 4xx or 5xx status code with a JSON error object:

```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing authentication token"
}
```

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

List endpoints support pagination via query parameters:

```bash
curl 'https://your-soat-server.com/api/v1/files?limit=25&offset=0' \
  -H "Authorization: Bearer <token>"
```

Responses include a `data` array and metadata about the result set. Pagination parameters:

- `limit` — Number of results per page (default: 25, max: 100)
- `offset` — Number of results to skip (default: 0)

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
| [Project Keys](/docs/api/project-keys/create-project-key)   | API keys scoped to projects                  |
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

const { data: files } = await soat.GET('/api/v1/files', {
  params: { query: { projectPublicId: 'proj_123' } },
});
```

Every endpoint, parameter, and response schema is fully typed.

## OpenAPI Specification

The REST API is defined in OpenAPI 3.1 format. Download the spec:

```
GET https://your-soat-server.com/openapi.yaml
```

Use this spec to generate clients in any language or integrate with API documentation tools.
