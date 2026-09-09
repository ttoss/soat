---
paths:
  - "packages/server/**"
  - "packages/website/**"
  - "packages/sdk/**"
  - "packages/cli/**"
---

# Modules

A module is a resource exposed through REST, MCP and the website. Change all
of them together.

## Checklist

- [ ] Lib: `packages/server/src/lib/<module>.ts`
- [ ] Routes: `packages/server/src/rest/v1/<module>.ts` with `@openapi` JSDoc,
      mounted in `src/rest/v1/index.ts`
- [ ] Spec: `packages/server/src/rest/openapi/v1/<module>.yaml`, then
      `pnpm --filter @soat/sdk generate` and `pnpm --filter @soat/cli generate`
- [ ] Permissions: `packages/server/src/permissions/<module>.json`, then
      `pnpm --filter @soat/website generate-permissions-page`
- [ ] Docs: `packages/website/docs/modules/<module>.md` (overview, data model,
      access rules; no endpoint listings — the reference is generated)
- [ ] ID examples use `PUBLIC_ID_PREFIXES` (`packages/postgresdb/src/utils/publicId.ts`)
- [ ] Tests: `packages/server/tests/unit/tests/rest/<module>.test.ts`; MCP via
      `tests/rest/mcp.test.ts`
- [ ] Live QA against a running server
- [ ] Formation schema synced (below) if the module has a resource type
- [ ] Any operation that outlasts a request exposes `wait` (`sync-async.md`)

MCP tools derive from the specs (`src/lib/soatTools.ts` → `src/mcp/server.ts`);
there are no per-module MCP files.

## Formations sync

A module with a `*FormationModule` in
`packages/server/src/lib/formation-modules/` keeps its `*ResourceProperties`
schema in `packages/server/src/rest/openapi/v1/formations.yaml` in sync with
its REST spec. That schema is the sole allowlist: `formationSpecLoader.ts`
derives allowed fields, required fields and types from it, and an unlisted
field is `400 Unknown <resource> field`.

Every module is `defineFormationModule({ … })`
(`formation-modules/defineFormationModule.ts`), declaring only:

| Key | Content |
|---|---|
| `resourceType` | the template type (`model_route`); schema name derives from it (`ModelRouteResourceProperties`, pinned by `formationsResourceTypeContract.test.ts`) |
| `extraChecks` / `warnChecks` | resource-specific validation |
| `create` / `update` / `remove` | property → lib-arg mapping |
| `fetch` + optional `read` | load the live resource; declare `read` only when a field is transformed, else `pickSpecFields` selects the schema's keys verbatim |

Never hand-write the skeleton (#900, #901).

When adding a field: REST spec → `formations.yaml` schema → `create`/`update`
pass it → `read` returns it (if declared).

## Shared business rules

Transport-independent rules (mutual exclusivity, invariants, preconditions)
live once in `src/lib/<module>.ts` as an exported pure function used by both
the route and the formation module. Schema-driven formation validation
(`pushUnknownFieldErrors` etc.) is not shared; REST relies on types for that.
