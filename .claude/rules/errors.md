---
paths:
  - "packages/server/**"
---

# Error Handling

## DomainError

All business-logic errors **must** be signalled by throwing a `DomainError`.
Never return error strings or `null`.

```ts
import { DomainError } from '../errors';

throw new DomainError('RESOURCE_NOT_FOUND', `Project '${id}' not found.`);

// With optional metadata
throw new DomainError('NAME_CONFLICT', `Formation '${name}' already exists.`, {
  name,
});
```

`DomainError` lives in `packages/server/src/errors/`:

| File             | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `codes.ts`       | `ERROR_CODES` registry — the only place to add/edit codes |
| `DomainError.ts` | Class definition                                          |
| `index.ts`       | Barrel export (`DomainError`, `ERROR_CODES`, `ErrorCode`) |

### Fields

| Field        | Type                                   | Description                                           |
| ------------ | -------------------------------------- | ----------------------------------------------------- |
| `code`       | `ErrorCode`                            | Key from `ERROR_CODES`, e.g. `'RESOURCE_NOT_FOUND'`   |
| `httpStatus` | `number`                               | Derived automatically from `ERROR_CODES[code]`        |
| `message`    | `string`                               | Human-readable description (set via `super(message)`) |
| `meta`       | `Record<string, unknown> \| undefined` | Optional structured context                           |

## ERROR_CODES registry

All valid codes are defined in `packages/server/src/errors/codes.ts`.
**Do not invent ad-hoc status codes in route handlers** — look up or add a code here.

Some example codes:

| Code                 | Status | Typical use                                     |
| -------------------- | ------ | ----------------------------------------------- |
| `RESOURCE_NOT_FOUND` | 404    | Generic "this thing doesn't exist"              |
| `AGENT_NOT_FOUND`    | 400    | A request body field references a missing agent |
| `NAME_CONFLICT`      | 409    | Duplicate name within a project                 |
| `FORBIDDEN`          | 403    | Insufficient permissions                        |
| `UNAUTHORIZED`       | 401    | Missing or invalid authentication               |

See `packages/server/src/errors/codes.ts` for the full list.

> **Note:** "referenced entity not found" codes use **400** because the error is caused by a bad
> request field, not a missing top-level resource (which would be 404).

### Adding a new code

1. Add an entry to the `ERROR_CODES` object in `codes.ts`:

   ```ts
   WIDGET_LOCKED: {
     httpStatus: 409,
     description: 'The widget is locked and cannot be modified.',
   },
   ```

2. `ErrorCode` is derived automatically via `keyof typeof ERROR_CODES` — no extra steps needed.

## find* vs get* naming rule

| Prefix  | Signature                   | Behaviour when absent |
| ------- | --------------------------- | --------------------- |
| `find*` | `findFoo(...): Foo \| null` | Returns `null`        |
| `get*`  | `getFoo(...): Foo`          | Throws `DomainError`  |

```ts
// find* — caller decides what to do with null
const project = await findProject({ projectId });
if (!project) {
  return null;
}

// get* — always resolves to a value or throws
const project = await getProject({ projectId });
// guaranteed non-null here
```

Use `get*` in route handlers so errors propagate automatically to the middleware.

## Error middleware — response shapes

`packages/server/src/middleware/errorLogger.ts` catches all unhandled errors and
sets the response. **Never add a try/catch in a route handler just to convert errors
to HTTP responses** — let errors propagate to the middleware.

| Error type              | HTTP status         | Response body                                                        |
| ----------------------- | ------------------- | -------------------------------------------------------------------- |
| `DomainError`           | `error.httpStatus`  | `{ error: { code, message, meta? } }`                                |
| Koa HTTP error, exposed | the error's status  | `{ error: { code: 'REQUEST_REJECTED', message } }`                   |
| Anything else           | 500                 | `{ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } }` — **raw `error.message` is never forwarded** |

`{ error: { code, message, meta? } }` is the **only** error shape the API
returns — `401`, `403` and the 500 catch-all included. A client never has to
test the type of `error` before reading `error.code`.

Leaving the catch-all as a bare string was the last exception, and it was the
worst one to leave: a catch-all is the response that arrives unannounced, so it
is the one a client is least likely to have special-cased.

### Consuming DomainError responses in tests

`response.body.error` is an **object** for `DomainError`, not a string:

```ts
// ✅ correct
expect(response.status).toBe(404);
expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
expect(response.body.error.message).toMatch(/not found/i);

// ❌ wrong — error is not a string for DomainErrors
expect(response.body.error).toContain('not found');
```

Generic (non-domain) errors are the same shape, under a fixed code:

```ts
expect(response.status).toBe(500);
expect(response.body.error.code).toBe('INTERNAL_ERROR');
expect(response.body.error.message).toBe('Internal Server Error');
```

### CLI error display

The CLI reads the SDK's `result.error` (which is the raw API response body) and
spreads it directly into the output object:

```
{ status: 404, error: { code: 'RESOURCE_NOT_FOUND', message: 'Session not found' } }
```

This avoids the nested `error.error` pattern that would occur if the body were
wrapped again. **Do not** wrap API error bodies in an extra `error` key in the CLI.

## The auth/scope preamble

Every guard in `src/rest/v1/helpers.ts` throws; none writes a response. Pick one
and call it as a bare statement — there is no `return` bookkeeping and no boolean
to check:

| Helper | Use for | Throws |
| --- | --- | --- |
| `requireAuth(ctx)` | a route with no project to resolve (`/users/me`, OAuth introspection, sub-resources authorized against a parent) | `UNAUTHORIZED` |
| `resolveReadProjectIds({ ctx, action, resourceType, projectPublicId? })` | a list/read route — a `Get`/`List`/`Search`/`Export` action and nothing else; **an empty scope is allowed** and yields an empty result | `UNAUTHORIZED` · `API_KEY_PROJECT_SCOPE` · `FORBIDDEN` |
| `requireProjectAccess({ … })` | a route that loads one resource and checks its project; **an empty scope is a `403`**, not a `404` | the same, plus `FORBIDDEN` on an empty scope |
| `resolveWriteProjectId({ … })` | a create/write route needing one concrete project | the same, plus `VALIDATION_FAILED` when no project can be inferred |
| `requireAdmin(ctx, action)` | the non-IAM role gate (users, policies, projects, price book) | `UNAUTHORIZED` · `FORBIDDEN` |
| `requireOwnerOrAdmin(ctx, { ownerPublicId, action })` | own-resource-or-admin (API keys) | `UNAUTHORIZED` · `FORBIDDEN` |

`requireAuth` is a TypeScript **assertion**, so a bare `requireAuth(ctx);`
narrows `ctx.authUser` for the rest of the block — never write `ctx.authUser!`.

**Never call `ctx.authUser.resolveProjectIds` from a route.** It skips the
credential-scope check and leaves you to re-decide how `null` and `[]` map to
statuses — the 26 copies of that decision are what made the routes disagree.

Three static checks enforce this; each replaced a prose rule that had already
lost:

| Test | Catches |
| --- | --- |
| `rest/errorShapeContract.test.ts` | a manual `ctx.body = { error: … }`, an inline `!ctx.authUser`, or a direct `resolveProjectIds` call in `src/rest/v1` |
| `rest/adminGateContract.test.ts` | a hand-rolled `role !== 'admin'` gate that answers `403` — in either denial form |
| `rest/wireKeyContract.test.ts` | a handler reading a camelCase wire key |
| `rest/readScopeHelperContract.test.ts` | `resolveReadProjectIds` guarding an action that is not a `Get`/`List`/`Search`/`Export` — the read helper on a write route |

That last one is the fourth copy of the same lesson. Thirteen write routes —
agent update/delete, version restore, release set/promote/abort, guardrail
update/delete/evaluate/restore — reached for `resolveReadProjectIds`, so an
unauthorized caller fell through the permitted empty scope into the scoped
lookup and got `404 RESOURCE_NOT_FOUND` from a route whose `GET` twin answered
`200` for them at the same instant (#1029). Worse, an empty scope is not itself
a denial, so the lib validated the body first and a `400` told the caller their
body was malformed on a route they could not call at all.

The rule is only checkable at the call site: both helpers return
`number[] | undefined`, and picking the wrong one produces a *plausible* status
rather than a broken one. So the action name carries it — a write action passed
to the read helper is a build failure, not a review note.

## Route handler rules

1. **Do not wrap lib calls in try/catch** just to set `ctx.status` — let `DomainError` propagate.
2. **Do not set `ctx.body = { error: '...' }` manually** — throw `DomainError` with the appropriate code instead.
3. Only use try/catch when you need to perform cleanup (e.g., rolling back a transaction) and then re-throw.
4. **Do not re-derive the auth/scope preamble** — call one of the helpers above.

```ts
// ✅ correct — DomainError propagates to middleware
if (!ctx.authUser) {
  throw new DomainError('UNAUTHORIZED', 'Unauthorized');
}
const agent = await getAgent({ agentId, projectId });
ctx.body = agent;
ctx.status = 200;

// ✅ better — the shared preamble does auth + credential scope + 403 in one call
const projectIds = await resolveReadProjectIds({
  ctx,
  action: 'agents:GetAgent',
  resourceType: 'agent',
});
ctx.body = await getAgent({ projectIds, id: ctx.params.agent_id });

// ❌ wrong — manual error body creates an inconsistent string format
if (!ctx.authUser) {
  ctx.status = 401;
  ctx.body = { error: 'Unauthorized' };
  return;
}

// ❌ wrong — swallows the structured error
try {
  const agent = await getAgent({ agentId, projectId });
  ctx.body = agent;
} catch {
  ctx.status = 500;
}
```
