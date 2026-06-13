# App Test Instructions

How to write tests for `@soat/app` (the React UI served at `/app`). For server
tests see `tests.md`; this document covers the browser app only.

## Golden Rule — Mock the API, Nothing Else

**Never mock internal components, hooks, providers, the `apiFetch` wrapper, or
`@soat/sdk`.** The only seam you are allowed to stub is the **HTTP boundary**,
via [MSW](https://mswjs.io/docs/http/). Everything above the wire — components,
contexts, the SDK client, request serialization, error handling — runs for real.

This keeps tests behavior-focused and refactor-proof: a test that drives a form
and asserts the request body at an MSW handler survives any internal rewrite (it
already survived the `apiFetch` → `@soat/sdk` migration untouched).

Do **not** reach for `vi.mock('@/...')`, `vi.mock('@soat/sdk')`, or fake context
providers. If you feel the need to, the test is set up wrong.

## Stack

- **Vitest** (`environment: 'jsdom'`, `globals: true`) — config in `packages/app/vitest.config.ts`
- **@testing-library/react** + **@testing-library/user-event** — render and interact
- **@testing-library/jest-dom** — DOM matchers (wired in `tests/unit/setup.ts`)
- **msw** (`msw/node`) — the network mock

## Location and Naming

- Tests live in `packages/app/tests/unit/`, mirroring the source tree
  (`engine/`, `auth/`, `views/`, `api/`).
- Name files `<module>.test.ts` (logic) or `<component>.test.tsx` (components).
- Tests stay **out of `src/`** on purpose: the package lints with `eslint src`,
  so test files are excluded from the production lint rules.
- Import app code through the `@/` alias (`@/engine/specUtils`), the same alias
  used in `src` — it is mirrored in `vitest.config.ts`.

## Running

```bash
pnpm --filter @soat/app test               # run once
pnpm --filter @soat/app test:watch          # watch mode
pnpm --filter @soat/app exec vitest run tests/unit/engine/listView.test.tsx   # single file
pnpm --filter @soat/app exec vitest run --coverage                            # coverage
```

## Harness Files (do not duplicate these per test)

| File | Purpose |
|---|---|
| `tests/unit/setup.ts` | jest-dom matchers; starts/stops the MSW server; `cleanup()` + `resetHandlers()` + `localStorage.clear()` after each test |
| `tests/unit/msw/server.ts` | the singleton `server` — import it to override handlers |
| `tests/unit/msw/handlers.ts` | default handlers (`/users/me`, `/users/login`, `/openapi.json`, `/projects`) + `TEST_USER` |
| `tests/unit/fixtures/spec.ts` | `testSpec`, a realistic OpenAPI spec that drives the generic engine |
| `tests/unit/testUtils.tsx` | `renderWithAuth(ui)` and `NavProbe` |

MSW runs with `onUnhandledRequest: 'error'`. **Every request a test triggers must
have a handler** — either a default in `handlers.ts` or a per-test `server.use`.

## Two Kinds of Test

### 1. Pure logic — no DOM, no MSW

For `specUtils.ts`, `formHelpers.ts`, and any other pure function. Just import
and assert; use `testSpec` as input where a spec is needed.

```ts
import { parseModules } from '@/engine/specUtils';
import { testSpec } from '../fixtures/spec';

test('treats an item-scoped POST as an action, not a create', () => {
  const agents = parseModules(testSpec).find((m) => m.tag === 'Agents')!;
  expect(agents.actions?.[0].operation.operationId).toBe('generateAgent');
});
```

### 2. Component / integration — real providers + MSW

Use `renderWithAuth`, which mounts the component inside the **real**
`AuthProvider` and `NavigationProvider`. Auth is driven through its genuine
public flow (a token in `localStorage` + the default `/users/me` handler), so no
provider is mocked. Engine views receive `module` / `spec` / `pathParams` as
props built from `testSpec`.

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { ListView } from '@/engine/listView';
import { parseModules } from '@/engine/specUtils';
import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { NavProbe, renderWithAuth } from '../testUtils';

test('clicking "View →" navigates to the detail view', async () => {
  server.use(
    http.get('*/api/v1/agents', () =>
      HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
    )
  );
  const agents = parseModules(testSpec).find((m) => m.tag === 'Agents')!;

  renderWithAuth(
    <>
      <ListView module={agents} spec={testSpec} pathParams={{}} />
      <NavProbe />
    </>
  );

  await userEvent.click(await screen.findByRole('button', { name: 'View →' }));
  expect(screen.getByTestId('nav-probe')).toHaveTextContent('"mode":"detail"');
});
```

## Conventions and Gotchas

- **Wildcard the host in handlers.** In jsdom, relative requests resolve against
  `http://localhost/`, so match `http://*` / `*/api/v1/...`, not bare paths:
  `http.get('*/api/v1/agents', ...)`. Use `:param` for path params
  (`'*/api/v1/agents/:agent_id'`).
- **Assert at the handler, not the implementation.** To verify a request body,
  headers, or method, read them inside the handler and assert afterward:
  ```ts
  let body: unknown;
  server.use(http.post('*/api/v1/agents', async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ id: 'agt_2' }, { status: 201 });
  }));
  // ...act...
  expect(body).toEqual({ name: 'Gamma' });   // proves buildRequestBody for real
  ```
- **Observe navigation with `NavProbe`,** never by mocking the navigation
  context. Render `<NavProbe />` as a sibling and assert on its `nav-probe`
  testid; it serializes the live `view` / `activeProjectId`.
- **Prefer `findBy*` over `getBy*`** for anything that appears after a request
  resolves — most engine views start in a `Loading…` state.
- **Auth in tests:** `renderWithAuth` sets a token and relies on the default
  `/users/me` handler. To test a rejected session, override `/users/me` to
  return 401; to test login failure, post with password `"wrong"` (the default
  login handler returns 401 for it).
- **Coverage:** keep the suite above the existing bar (~90% statements). Every
  new lib function, view, and context branch (happy path, error path, empty
  state, 401/403/404) needs coverage — mirror the server's coverage discipline.
- **Adding a new module/resource?** Extend `tests/unit/fixtures/spec.ts` so
  `parseModules` produces the new module, then test its views the same way.
  Add a default handler to `handlers.ts` only if most tests need it; otherwise
  override per test with `server.use`.

## Checklist

- [ ] Test lives under `packages/app/tests/unit/` mirroring the source path
- [ ] Only the network is mocked (MSW); no component / hook / SDK / `apiFetch` mocks
- [ ] Real providers via `renderWithAuth` (or `SpecProvider`/`AuthProvider` directly)
- [ ] Handlers use the `*` host wildcard and cover every request the test makes
- [ ] Request bodies/headers asserted at the handler where relevant
- [ ] Navigation asserted via `NavProbe`, not a mock
- [ ] Error, empty, and unauthorized paths covered, not just the happy path
- [ ] `pnpm --filter @soat/app test` passes
