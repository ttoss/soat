---
paths:
  - "packages/server/**"
  - "packages/postgresdb/**"
  - "packages/sdk/**"
  - "packages/cli/**"
---

# Case Convention

Wire is **snake_case**; internal TypeScript is **camelCase**. A lib mapper
converts field by field at one boundary. No middleware, no skip list, no
recursive key transform anywhere.

**Never write a function that walks a JSON value and rewrites its keys.**
Opaque bags (JSON Logic, header names, IAM vocabulary, tags, guardrail
documents, formation templates) are copied as values, so their keys are never
touched.

## Outbound — lib mappers

```ts
const mapActor = (actor: ActorRow) => ({
  id: actor.publicId,
  project_id: actor.project?.publicId,
  external_id: actor.externalId ?? undefined,
  memory_id: getLinkedPublicId(actor.memory),
  tags: actor.tags ?? undefined, // opaque bag, copied as a value
  created_at: actor.createdAt,
});
```

A lib return value is wire-shaped: consumers read `actor.project_id` or use
the model instance. Webhook payloads and the NDJSON audit export use the same
mappers.

## Inbound — route handlers

Read the body/query as sent, pass explicit camelCase args:

```ts
const { trace_id: traceId, tool_context: toolContext } = ctx.request.body as {
  trace_id?: string;
  tool_context?: Record<string, string>;
};
```

## Surfaces

| Surface | Case |
|---|---|
| REST bodies, queries, path params, OpenAPI, SDK, CLI, webhooks, NDJSON, MCP inputs/outputs | snake_case |
| MCP tool names | kebab-case (`operationIdToToolName`) |
| Internal TS, models, lib args | camelCase |

OpenAPI's own structural vocabulary (`operationId`, `requestBody`) stays
camelCase. MCP tool inputs are the spec property names verbatim
(`agent_id`), results are the REST JSON unrewritten.

## Enforcement

| Check | Catches |
|---|---|
| `strictFields` middleware (read-only) | unknown field at any depth or missing required top-level field → `400 VALIDATION_FAILED` |
| `responseContract` middleware (read-only) | camelCase response key → throws in tests; undeclared snake_case key → debug log (pre-existing drift, `tests/unit/openapiContract.ts`) |
| `rest/wireKeyContract.test.ts` | a handler reading a camelCase key off `ctx.request.body` / `ctx.query` |
| `lib/libReturnKeyContract.test.ts` | a camelCase key inside an otherwise snake_case object literal in lib |

Both middlewares derive fields from the specs via `deriveSchemaFields`, which
has no key-transform hook. Permission helpers type a project-owned resource as
`ProjectOwned` (`rest/v1/helpers.ts`) — required but possibly `undefined` — not
`project_id?: string`.

## Adding a field

1. camelCase on the model and lib args.
2. snake_case in the OpenAPI YAML.
3. snake_case in the lib mapper.
4. snake_case read in the handler.
