---
applyTo: '**'
description: Instructions for creating and maintaining modules across the codebase.
---

# Module Instructions

A module is a named resource (e.g., `files`, `users`) that is exposed through the REST API, the MCP server, and documented in the website. Whenever a module is created or changed, **all four areas must be updated together**:

1. **REST** — route handlers and OpenAPI spec
2. **MCP** — tool definitions in the MCP server
3. **Docs** — module documentation in the website
4. **Tests** — unit tests covering the new or changed behavior

## Checklist for Every Module Change

- [ ] Business logic updated in `packages/server/src/lib/<module>.ts`
- [ ] REST routes updated in `packages/server/src/rest/v1/<module>.ts` with `@openapi` JSDoc blocks
- [ ] Module router registered in `packages/server/src/rest/v1/index.ts`
- [ ] MCP tools updated in `packages/server/src/mcp/tools/<module>.ts`
- [ ] Module docs updated in `packages/website/docs/modules/<module>.md`
- [ ] Tests updated in `packages/server/tests/unit/tests/<module>.test.ts`

## REST

Follow the rules in `server.instructions.md`. Each module gets its own file under `src/rest/v1/<module>.ts` and must be mounted in `src/rest/v1/index.ts`.

## MCP

Each module operation must be exposed as an MCP tool in its own file at `src/mcp/tools/<module>.ts`. The file must export a `registerTools` function that accepts a `McpServer` instance. It must then be imported and called in `src/mcp/tools/index.ts`. Tool names follow the pattern `<verb>-<module>` (e.g., `list-files`, `create-user`). Tools call REST endpoints via `apiCall` using the same paths defined in the REST routes.

## Docs

Each module has a dedicated documentation page at `packages/website/docs/modules/<module>.md`. The page must describe:

- What the module does (overview)
- Key concepts and data model
- Any roles or access rules that apply

Do **not** document REST endpoints in the module docs — those are covered in the auto-generated API reference.

## Tests

Tests live in `packages/server/tests/unit/tests/<module>.test.ts`. Every public lib function and every REST route must have at least one test. Follow the patterns already established in `files.test.ts` and `users.test.ts`.
