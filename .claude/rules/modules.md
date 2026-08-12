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
- [ ] OpenAPI spec (`packages/server/src/rest/openapi/v1/<module>.yaml`) updated
- [ ] `pnpm --filter @soat/sdk generate` run after OpenAPI changes
- [ ] `pnpm --filter @soat/cli generate` run after OpenAPI changes
- [ ] Permission actions updated in `packages/server/src/permissions/<module>.json`
- [ ] Permissions Reference page regenerated: `pnpm --filter @soat/website generate-permissions-page`
- [ ] Module docs updated in `packages/website/docs/modules/<module>.md`
- [ ] ID examples use runtime prefixes (`packages/postgresdb/src/utils/publicId.ts`)
- [ ] Tests updated in `packages/server/tests/unit/tests/<module>.test.ts`
- [ ] Live QA pass run for the new/changed behavior against a running server
- [ ] Formation schema synced if the module has a formation resource type (see [Formations Sync](#formations-sync))
- [ ] Any operation that can outlast a request exposes the `wait` toggle, defaulting to background (see `.claude/rules/sync-async.md`)

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

## Formations Sync

Any module that has a corresponding formation resource type (i.e. a `*FormationModule` in `packages/server/src/lib/formation-modules/`) **must keep the formation schema in sync with the REST OpenAPI spec**. This is a separate step from updating the main module's OpenAPI spec.

### What triggers a formation sync

| Change type | Action required |
|---|---|
| New field added to a resource via the REST API | Add the same field (snake_case) to the matching `*ResourceProperties` schema in `packages/server/src/rest/openapi/v1/formations.yaml` |
| Field removed or renamed | Remove or rename the corresponding property in `formations.yaml` |
| Field added to `*ResourceProperties` | Add handling in the formation module's `create` / `update`, and in its `read` if it declares one |

### How a formation module is written

Every module is a `defineFormationModule({ … })` config object
(`packages/server/src/lib/formation-modules/defineFormationModule.ts`). The
factory owns the mechanical half — the object guard, the schema load, the
unknown/required/type checks, the apply-time re-validation and `errors[0]`
throw, the camelCase normalization, the `read` drift contract, and the log
lines. A module declares only its genuine content:

| Key | What it is |
|---|---|
| `resourceType` | the type a template declares (`model_route`) |
| `extraChecks` / `warnChecks` | the resource-specific validation only |
| `create` / `update` / `remove` | the property→lib-arg mapping |
| `fetch` + optional `read` | how to load the live resource and view it |

Do **not** hand-write the skeleton again — that is exactly how #900 and #901
happened. The schema name is **derived** from `resourceType`
(`model_route` → `ModelRouteResourceProperties`), so there is no per-module
`SCHEMA_NAME` to keep in sync; `formationsResourceTypeContract.test.ts` asserts
the rule holds for every registered type.

Omit `read` when the template view is exactly the schema's declared fields taken
verbatim from an already-snake_case lib mapper — `pickSpecFields` selects them.
Declare `read` when any field is transformed (a Date to ISO, a nested document
flattened). `pickSpecFields` **selects** declared keys; it never rewrites a name
(`.claude/rules/case-convention.md`).

### How the validator works

`formationSpecLoader.ts` reads the `*ResourceProperties` schema from `formations.yaml` at runtime and derives:

- **allowed fields** — the `properties` keys; any field not listed here triggers "Unknown `<resource>` field" with HTTP 400
- **required fields** — the `required` array
- **field types** — the `type` of each property

This means the YAML schema is the **sole allowlist** for formation templates. A field that exists in the REST API but not in `formations.yaml` will always be rejected by `update-formation`.

### Checklist

When adding or changing a resource field:

- [ ] Field added/updated in the module's REST OpenAPI spec (`packages/server/src/rest/openapi/v1/<module>.yaml`)
- [ ] Same field added/updated in `AgentResourceProperties` (or equivalent) in `packages/server/src/rest/openapi/v1/formations.yaml`
- [ ] Formation module updated: its `create` / `update` pass the new field to the lib function
- [ ] If the module declares an explicit `read`, it returns the new field (snake_case); a module without one picks it up from the schema automatically

## Shared Business Rules

Business rules that apply to a resource **must be defined once in `src/lib/<module>.ts`** and reused by both the REST route handler and the formation module. Never duplicate a business rule across the two layers.

A business rule is any constraint that is independent of the transport layer: mutual exclusivity of fields, invariants on combinations of values, domain-specific preconditions.

**Pattern**: export a pure validation function from the lib module and import it in both places.

```ts
// src/lib/actors.ts — single source of truth
export const validateActorExclusivity = (args: {
  agentId: unknown;
  chatId: unknown;
}): string | null => {
  if (args.agentId && args.chatId) {
    return 'agentId and chatId are mutually exclusive';
  }
  return null;
};
```

```ts
// src/rest/v1/actors.ts — REST route uses it
import { validateActorExclusivity } from 'src/lib/actors';
const error = validateActorExclusivity({
  agentId: body.agentId,
  chatId: body.chatId,
});
if (error) {
  ctx.status = 400;
  ctx.body = { error };
  return;
}
```

```ts
// src/lib/formation-modules/actorsFormationModule.ts — formation module uses it
import { validateActorExclusivity } from '../actors';
const msg = validateActorExclusivity({
  agentId: properties.agent_id,
  chatId: properties.chat_id,
});
if (msg) errors.push({ path: basePath, message: msg });
```

**What is NOT shared**: schema-driven formation validation (`pushUnknownFieldErrors`, `pushRequiredFieldErrors`, `pushFieldTypeErrors`) is formation-specific infrastructure for validating untyped template properties. REST handlers rely on TypeScript types for those same checks and do not need to share that layer.
