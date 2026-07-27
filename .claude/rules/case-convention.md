# Case Convention

The wire is **snake_case**. Internal TypeScript is **camelCase**. A lib mapper
converts between them explicitly, field by field, at one boundary.

That is the whole rule. There is no middleware, no skip list, and no recursive
key transform anywhere in the request or response path.

## The one hard prohibition

**Never write a function that walks a JSON value and rewrites its keys.**

Every case-transform incident in this project's history (#651, #690, #729, #737)
had the same shape: a key-blind recursive transform rewrote every key at a
boundary, and correctness depended on a hand-curated skip list that someone had
to remember to extend. Not one incident involved a field SOAT owns. They were all
keys the platform does not own and must never touch:

| What | Example | What the recursion did to it |
|---|---|---|
| JSON Logic vars / operators | `{"var": "context.max_daily_budget"}` | rewrote the path; every underscore key resolved to `null` |
| HTTP header names | `X-Auth`, `tool_context` keys | `X-Auth` → `_x-_auth`; `actor_external_id` → header `…-ActorExternalId` |
| IAM vocabulary | `StringEquals`, `soat:ResourceTag/env` | → `_string_equals`, `soat:_resource_tag/env` |
| Resource tag keys | `cost_center` + `costCenter` | collapsed two distinct tags into one, dropping a value |
| Contract-fixed fields | a guardrail document's `default_class` | → `defaultClass`, rejected on write as unknown |
| Author-authored template fields | formation `template` resource IDs | returned template diverged from what was stored |

Explicit serialization makes the bug class unrepresentable. An opaque bag is
copied as a **value**, so its inner keys are never even looked at — there is
nothing to exempt, because nothing was at risk.

## Where the conversion happens

### Outbound — lib mappers

A lib function returns a plain object built field by field, with the spec's own
snake_case names:

```ts
const mapActor = (actor: ActorRow) => {
  return {
    id: actor.publicId, // publicId is exposed as `id`
    project_id: actor.project?.publicId,
    external_id: actor.externalId ?? undefined,
    memory_id: getLinkedPublicId(actor.memory),
    tags: actor.tags ?? undefined, // an opaque bag: copied as a value
    created_at: actor.createdAt,
  };
};
```

This is the single serialization point. The field list already had to exist (see
`server.md`: lib functions must return explicitly mapped plain objects), so
nothing is duplicated by keying it in snake_case.

Consequences to keep in mind:

- **A lib return value is wire-shaped.** Internal code that consumes one reads
  the snake_case key (`actor.project_id`) or works from the model instance
  instead. TypeScript enforces this — the mapper's inferred type is the contract.
- **Webhook payloads and the NDJSON audit export use the same mappers**, so they
  are consistent with the read API by construction. That is what killed #690.

### Inbound — route handlers

Handlers read the body and query exactly as the client sent them, then pass
explicit camelCase args to the lib function:

```ts
const body = ctx.request.body as {
  project_id?: string;
  external_id?: string;
};

await createActor({
  projectId: Number(targetProjectId),
  externalId: body.external_id,
});
```

Destructuring aliases the wire name to the internal one, which keeps the mapping
visible at the read site:

```ts
const { trace_id: traceId, tool_context: toolContext } = ctx.request.body as {
  trace_id?: string;
  tool_context?: Record<string, string>;
};
```

Because nothing rewrites inbound keys, two things that used to be possible no
longer are: a caller-authored key inside a bag cannot be mangled before it
reaches the lib, and two keys (`user_id` + `userId`) can no longer collide into
one and silently drop a value.

## Surfaces

| Surface | Convention | Produced by |
|---|---|---|
| REST bodies, queries, path params | snake_case | explicit per-resource mappers |
| OpenAPI specs | snake_case | authored |
| SDK / CLI | snake_case | generated from the specs |
| MCP tool **names** | kebab-case | `operationIdToToolName` from `operationId` |
| MCP tool inputs / outputs | snake_case | schemas from the specs verbatim; responses passed through verbatim |
| Webhook payloads, NDJSON export | snake_case | the same lib mappers as REST |
| Internal TS, models, lib args | camelCase | handlers map at the boundary |

The OpenAPI document served at `/api/v1/openapi.json` keeps its **camelCase
structural vocabulary** (`operationId`, `requestBody`) — that is valid OpenAPI,
describing snake_case field names.

MCP speaks snake_case, the same contract as everything else: tool `inputSchema`
properties are the spec's property names verbatim, path-parameter arguments are
the spec's names (`agent_id`, not `agentId`), and a tool result is the REST
response JSON-stringified with nothing rewritten. An agent that reads the docs
can call a tool with no translation, and there is nothing left to drift.

## Enforcement

Two middlewares check the contract. **Neither modifies a body** — they only read.

| Middleware | Direction | On violation |
|---|---|---|
| `strictFields` | request | `400 VALIDATION_FAILED` — unknown field at any nesting level, or a missing top-level required field |
| `responseContract` | response | camelCase key → throws in tests; undeclared snake_case key → debug log |

Both derive their field sets from the OpenAPI specs via `deriveSchemaFields`,
which keys everything by the spec's own property name. It deliberately has **no
key-transform hook**: a field name cannot be rewritten on its way from the spec
to the check that uses it.

`responseContract` is the deterministic replacement for what used to be a prose
rule. A mapper that forgets to convert a field fails the REST suite with the
field named. It only logs an undeclared *snake_case* key, because that is
pre-existing spec drift (~1900 cases, tracked in `tests/unit/openapiContract.ts`)
rather than the bug this rule is about.

## Adding a new field

1. Add it in **camelCase** to the model and lib args.
2. Add it in **snake_case** to the OpenAPI spec YAML.
3. Add it in **snake_case** to the lib mapper, mapping from the camelCase model
   attribute.
4. Read it in **snake_case** in the route handler.

Nothing converts automatically, and that is the point: every field name on the
wire appears literally in the mapper, so you can grep for it.
