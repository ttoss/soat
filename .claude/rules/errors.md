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

| Error type    | HTTP status        | Response body                                                                     |
| ------------- | ------------------ | --------------------------------------------------------------------------------- |
| `DomainError` | `error.httpStatus` | `{ error: { code, message, meta? } }` (object)                                    |
| Any other     | 500                | `{ error: "Internal Server Error" }` — **raw `error.message` is never forwarded** |

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

For generic (non-domain) errors the body is a plain string:

```ts
expect(response.status).toBe(500);
expect(response.body.error).toBe('Internal Server Error');
```

### CLI error display

The CLI reads the SDK's `result.error` (which is the raw API response body) and
spreads it directly into the output object:

```
{ status: 404, error: { code: 'RESOURCE_NOT_FOUND', message: 'Session not found' } }
```

This avoids the nested `error.error` pattern that would occur if the body were
wrapped again. **Do not** wrap API error bodies in an extra `error` key in the CLI.

## Route handler rules

1. **Do not wrap lib calls in try/catch** just to set `ctx.status` — let `DomainError` propagate.
2. **Do not set `ctx.body = { error: '...' }` manually** — throw `DomainError` with the appropriate code instead.
3. Only use try/catch when you need to perform cleanup (e.g., rolling back a transaction) and then re-throw.

```ts
// ✅ correct — DomainError propagates to middleware
if (!ctx.authUser) {
  throw new DomainError('UNAUTHORIZED', 'Unauthorized');
}
const agent = await getAgent({ agentId, projectId });
ctx.body = agent;
ctx.status = 200;

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
