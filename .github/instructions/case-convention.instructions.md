---
applyTo: '**'
description: Case convention rules for the REST API, MCP, SDK, and internal code.
---

# Case Convention

This project uses an automatic case-transform middleware that decouples the external REST API contract (snake_case) from the internal JavaScript/TypeScript code (camelCase).

## REST API — External Contract

All REST API request and response **body fields** use **snake_case**:

```json
{
  "project_id": "prj_01",
  "ai_provider_id": "aip_01",
  "default_model": "gpt-4o"
}
```

This applies to every field in JSON request bodies and JSON response bodies under `/api/v1`.

## Internal Code — camelCase

All internal TypeScript code (models, lib functions, route handlers) uses **camelCase**:

```ts
const project = await Project.findOne({ where: { publicId: projectId } });
```

You never need to manually convert between cases in route handlers.

## caseTransform Middleware

The middleware at `packages/server/src/middleware/caseTransform.ts` handles automatic conversion for paths starting with `/api/v1`:

- **Inbound**: snake_case request body → camelCase (so handlers receive camelCase)
- **Outbound**: camelCase response body → snake_case (so clients receive snake_case)

### When adding new fields

1. Add the field in **camelCase** in the model and lib code.
2. Define the field in **snake_case** in the OpenAPI spec YAML.
3. The middleware converts automatically — no manual mapping needed.

## Path Parameters

Path parameters in URL templates use **snake_case**, consistent with the rest of the external REST API contract:

```
/api/v1/agents/{agent_id}/generate/{generation_id}/tool-outputs
```

In the SDK, `params.path` objects also use snake_case to match the URL templates:

```ts
params: { path: { agent_id: agent.id, generation_id: gen.id } }
```

## OpenAPI Specs

Property names in OpenAPI spec files (`packages/server/src/rest/openapi/v1/*.yaml`) must be **snake_case**. These specs define the external contract and are used to generate the SDK.

## MCP — camelCase

MCP tool `inputSchema` properties and response fields use **camelCase**. The MCP endpoint (`POST /mcp`) is **not** processed by the caseTransform middleware. The MCP tools layer has its own conversion in `packages/server/src/mcp/tools/caseTransform.ts` using `toMcpText` which converts API responses from snake_case back to camelCase for MCP clients.

## soat-tools — camelCase

SOAT tool input schemas use **camelCase**. These are internal tool definitions consumed by agents, not part of the REST API contract.

## SDK

The generated SDK (`packages/sdk/src/generated/openapi.ts`) reflects the OpenAPI specs:

- Body and response fields are **snake_case** (e.g., `body: { project_id: '...' }`)
- Path parameters are **snake_case** (e.g., `params: { path: { agent_id: '...' } }`)

## Summary Table

| Context                             | Convention | Example                                 |
| ----------------------------------- | ---------- | --------------------------------------- |
| REST body fields (request/response) | snake_case | `project_id`, `default_model`           |
| URL path parameters                 | snake_case | `{agent_id}`, `{generation_id}`         |
| OpenAPI spec properties             | snake_case | `project_id`                            |
| Internal TS code                    | camelCase  | `projectId`, `defaultModel`             |
| MCP tool schemas & responses        | camelCase  | `projectId`, `defaultModel`             |
| soat-tool input schemas             | camelCase  | `projectId`                             |
| SDK body fields                     | snake_case | `body: { project_id: '...' }`           |
| SDK path params                     | snake_case | `params: { path: { agent_id: '...' } }` |
