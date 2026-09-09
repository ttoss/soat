---
paths:
  - "packages/server/**"
---

# Error Handling

## DomainError

All business-logic errors throw `DomainError`; never return error strings or
`null` for errors.

```ts
import { DomainError } from '../errors';

throw new DomainError('NAME_CONFLICT', `Formation '${name}' already exists.`, { name });
```

`packages/server/src/errors/`: `codes.ts` (`ERROR_CODES` registry — the only
place codes are defined), `DomainError.ts`, `index.ts`. Fields: `code`
(`ErrorCode`), `httpStatus` (from the registry), `message`, `meta?`.

Add a code by adding a registry entry; `ErrorCode` derives from it:

```ts
WIDGET_LOCKED: { httpStatus: 409, description: 'The widget is locked and cannot be modified.' },
```

"Referenced entity not found" codes (e.g. `AGENT_NOT_FOUND`) are **400**: a bad
request field, not a missing top-level resource (404).

## `find*` vs `get*`

`findFoo(): Foo | null` returns null; `getFoo(): Foo` throws. Use `get*` in
route handlers.

## Response shape

`middleware/errorLogger.ts` sets every error response. The only shape is
`{ error: { code, message, hint, docs_url, meta? } }`:

| Error | Status | `code` |
|---|---|---|
| `DomainError` | `httpStatus` | its code |
| exposed Koa error | its status | `REQUEST_REJECTED` |
| anything else | 500 | `INTERNAL_ERROR`, message `Internal Server Error` (raw message never forwarded) |

`hint` and `docs_url` are never written by a handler: `errorBody` resolves them
from the code (`resolutionFor` / `docsUrlFor`, `src/errors/resolutions.ts`).
Add an `ERROR_RESOLUTIONS` entry when "what to do" is more specific than the
status class. Enforced by `lib/errorResolutions.test.ts` (every code has a
hint) and `@soat/website` `errorCodesPage.test.ts` (every `docs_url` anchor
exists on the generated Error Codes page).

Tests read `response.body.error.code`, never `toContain` on `error`.

The CLI spreads the SDK's `result.error` (the raw body) into its output; never
wrap it in another `error` key.

## Auth/scope preamble

Every guard in `src/rest/v1/helpers.ts` throws; call one as a bare statement:

| Helper | Use | Throws |
|---|---|---|
| `requireAuth(ctx)` | no project to resolve; TS assertion, narrows `ctx.authUser` (never `ctx.authUser!`) | `UNAUTHORIZED` |
| `resolveReadProjectIds({ ctx, action, resourceType, projectPublicId? })` | `Get`/`List`/`Search`/`Export` only; empty scope → empty result | `UNAUTHORIZED` · `API_KEY_PROJECT_SCOPE` · `FORBIDDEN` |
| `requireProjectAccess({ … })` | loads one resource; empty scope → `403` | same + `FORBIDDEN` |
| `resolveWriteProjectId({ … })` | create/write needing one project | same + `VALIDATION_FAILED` |
| `requireAdmin(ctx, action)` | non-IAM role gate | `UNAUTHORIZED` · `FORBIDDEN` |
| `requireOwnerOrAdmin(ctx, { ownerPublicId, action })` | own-resource-or-admin | `UNAUTHORIZED` · `FORBIDDEN` |

Never call `ctx.authUser.resolveProjectIds` from a route. Never use the read
helper on a write route (#1029).

Static checks: `rest/errorShapeContract.test.ts` (manual error bodies, inline
`!ctx.authUser`, direct `resolveProjectIds`), `rest/adminGateContract.test.ts`
(hand-rolled admin gate), `rest/wireKeyContract.test.ts`,
`rest/readScopeHelperContract.test.ts` (read helper on a non-read action).

## Route handler rules

- No try/catch to set `ctx.status`; let `DomainError` propagate. try/catch only
  for cleanup, then re-throw.
- Never `ctx.body = { error: … }`.
- Never re-derive the preamble.

```ts
const projectIds = await resolveReadProjectIds({ ctx, action: 'agents:GetAgent', resourceType: 'agent' });
ctx.body = await getAgent({ projectIds, id: ctx.params.agent_id });
```
