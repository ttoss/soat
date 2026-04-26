---
title: MCP Tools Generation Guide
description: How MCP tool files are generated directly from OpenAPI specs
---

# MCP Tools Generation from OpenAPI Specs

## Overview

MCP tool registration files are automatically generated from OpenAPI YAML specifications. This ensures that:

- MCP tools stay in sync with API specs
- Changes to the API automatically reflect in tools
- Single source of truth (the OpenAPI spec)
- No intermediate boilerplate layers

## How It Works

```
OpenAPI YAML Specs
    ↓ (generate-tools script reads)
    ↓
mcp/tools/generated/*.ts  (registerXxxTools functions)
    ↓
mcp/tools/generated/index.ts  (registerGeneratedTools)
    ↓
mcp/tools/index.ts  (registerTools → mcpServer)
```

### The Generation Process

1. **Script**: `packages/server/scripts/generateSoatTools.ts`
2. **Input**: All YAML files in `packages/server/src/rest/openapi/v1/`
3. **Output**: `packages/server/src/mcp/tools/generated/` (gitignored)
4. **Trigger**: Runs automatically during `pnpm build` (or manual: `pnpm run generate-tools`)

### What Gets Generated

For each OpenAPI module, a `register<Module>Tools(server: McpServer)` function is generated:

```typescript
// mcp/tools/generated/actors.ts
export const registerActorsTools = (server: McpServer) => {
  registerToolFromSchema(server, {
    name: 'list-actors',
    description: 'From OpenAPI description',
    inputSchema: { type: 'object', properties: { ... } },
    handler: async (args) => {
      const data = await apiCall('GET', '/actors', {});
      return { content: [{ type: 'text', text: toMcpText(data) }] };
    },
  });
  // ... one entry per operation
};
```

**Case conversion:**

- OpenAPI bodies use `snake_case` (`project_id`, `external_id`)
- MCP tool `inputSchema` properties use `camelCase` (`projectId`, `externalId`)
- The `caseTransform` middleware handles the mapping automatically

## Generated Modules

All modules below are fully generated from their OpenAPI specs:

- actors
- agents
- ai-providers
- api-keys
- chats
- conversations
- documents
- files
- policies
- projects
- secrets
- sessions
- users
- webhooks

## Running the Generator

```bash
# Automatic (during build)
pnpm build

# Manual
cd packages/server
pnpm run generate-tools
```

## Adding or Updating a Tool

When you add or change a field in the API:

1. Update the OpenAPI spec (`packages/server/src/rest/openapi/v1/<module>.yaml`)
2. Run `pnpm run generate-tools`

No manual edits to generated files are needed.

## File Locations

| Purpose              | Path                                                    |
| -------------------- | ------------------------------------------------------- |
| Generator script     | `packages/server/scripts/generateSoatTools.ts`         |
| OpenAPI specs        | `packages/server/src/rest/openapi/v1/*.yaml`            |
| Generated MCP tools  | `packages/server/src/mcp/tools/generated/` (gitignored) |
| MCP tools entry      | `packages/server/src/mcp/tools/index.ts`                |

## Common Issues

### Generated tool is missing a property

Check the OpenAPI spec for that operation. Add the missing property to the spec, then regenerate.

### Description has escaped quotes or special characters

Update the description in the OpenAPI YAML, then regenerate.

### Type shows as `string` instead of `number`

Ensure the OpenAPI schema uses `type: integer` or `type: number`, then regenerate.
