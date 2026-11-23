---
paths:
  - "packages/server/**"
---

# Server

Package docs: https://ttoss.dev/docs/modules/packages/http-server/ and
https://ttoss.dev/docs/modules/packages/http-server-mcp/.

## Layout

- `src/lib/<resource>.ts` — all business logic and DB access. Functions return
  plain, explicitly mapped objects, never model instances. `publicId` is
  exposed as `id`; the DB `id` never appears in a response, spec or MCP output.
  Route params that name a resource are always `publicId` values.
- `src/rest/v1/<resource>.ts` — handlers: parse, call lib, set status/body. No
  DB calls. Mounted via `src/rest/router.ts`; `src/index.ts` is app setup only.
- `src/rest/openapi/v1/<resource>.yaml` — source of truth for the SDK
  (`pnpm --filter @soat/sdk generate`), CLI manifest
  (`pnpm --filter @soat/cli generate`) and the MCP tool registry
  (`src/lib/soatTools.ts`, at runtime). Update it with every endpoint change.
- `src/mcp/` — `index.ts`, `server.ts`, `toMcpText.ts`. No per-module tool files.

## Paths

Every segment is a kebab-case literal or a `{snake_case}` parameter; never a
`:verb` suffix (`tests/harness/pathConvention.test.mjs`).

| Case | Form | Example |
|---|---|---|
| Read derived from a collection | noun under it | `GET /tasks/graph` |
| Action on a resource | verb under it | `POST /approvals/{approval_id}/approve` |
| Resource with its own id | hyphenated top-level segment | `GET /trigger-firings/{trigger_firing_id}` |

Register a literal before the parameter route it shares a prefix with
(`/tasks/graph` before `/tasks/:task_id`), and test that it is not read as an id.

## Commands

```bash
pnpm --filter @soat/server dev      # tsx watch
pnpm --filter @soat/server build    # tsup
pnpm --filter @soat/server test --testPathPatterns=users.test.ts
pnpm run -w dev                     # then curl http://0.0.0.0:5047/api/v1/... (not localhost)
```

Never `npx jest` or the singular `--testPathPattern`.

## Tests

Integration tests against `app.callback()` via supertest with a real Postgres
(see `tests.md`). Files: `packages/server/tests/unit/tests/rest/<module>.test.ts`.
Helpers in `tests/unit/testClient.ts`: `testClient`,
`authenticatedTestClient(token)` (also takes a raw `sk_` key), `loginAs`.

Nest `describe` by method and path. Every route: happy path with body shape
asserted (`id` defined, sensitive fields `toBeUndefined()`), `401`, `403`, edge
cases.
