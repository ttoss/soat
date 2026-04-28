---
applyTo: '**'
description: Instructions for creating and maintaining modules across the codebase.
---

# Module Instructions

A module is a named resource (e.g., `files`, `users`) that is exposed through the REST API, the MCP server, and documented in the website. Whenever a module is created or changed, **all four areas must be updated together**:

1. **REST** — route handlers and OpenAPI spec
2. **MCP** — the MCP surface derived from the OpenAPI spec
3. **Docs** — module documentation in the website
4. **Tests** — unit tests covering the new or changed behavior

## Checklist for Every Module Change

- [ ] Business logic updated in `packages/server/src/lib/<module>.ts`
- [ ] REST routes updated in `packages/server/src/rest/v1/<module>.ts` with `@openapi` JSDoc blocks
- [ ] Module router registered in `packages/server/src/rest/v1/index.ts`
- [ ] OpenAPI spec updated so the generated MCP tool surface stays correct
- [ ] `pnpm --filter @soat/sdk generate` run after OpenAPI changes
- [ ] `pnpm --filter @soat/cli generate` run after OpenAPI changes
- [ ] Module docs updated in `packages/website/docs/modules/<module>.md`
- [ ] Tests updated in `packages/server/tests/unit/tests/<module>.test.ts`

## REST

Follow the rules in `server.instructions.md`. Each module gets its own file under `src/rest/v1/<module>.ts` and must be mounted in `src/rest/v1/index.ts`.

## MCP

In this repo, REST-backed MCP tools are generated dynamically from the OpenAPI specs, not from per-module files. The MCP server loads tool definitions from `packages/server/src/lib/soatTools.ts`, which reads `packages/server/src/rest/openapi/v1/*.yaml` and exposes those operations through `packages/server/src/mcp/server.ts`.

When you change a module's REST surface:

- Update the OpenAPI spec first.
- Regenerate the SDK with `pnpm --filter @soat/sdk generate`.
- Regenerate the CLI manifest with `pnpm --filter @soat/cli generate`.
- Verify MCP behavior through `packages/server/tests/unit/tests/rest/mcp.test.ts`.

## Docs

Each module has a dedicated documentation page at `packages/website/docs/modules/<module>.md`. The page must describe:

- What the module does (overview)
- Key concepts and data model
- Any roles or access rules that apply

Do **not** document REST endpoints in the module docs — those are covered in the auto-generated API reference.

## Tests

Tests live in `packages/server/tests/unit/tests/<module>.test.ts`. Every public lib function and every REST route must have at least one test. Follow the patterns already established in `files.test.ts` and `users.test.ts`.
