---
paths:
  - "packages/app/**"
---

# App Tests (`@soat/app`)

## Mock the HTTP boundary, nothing else

Never mock components, hooks, providers, `apiFetch` or `@soat/sdk`
(no `vi.mock('@/...')`, no `vi.mock('@soat/sdk')`, no fake context providers).
The only stub is MSW at the network. MSW runs with
`onUnhandledRequest: 'error'`: every request needs a handler (a default in
`handlers.ts` or a per-test `server.use`).

## Stack and layout

Vitest (`jsdom`, `globals: true`; `packages/app/vitest.config.ts`),
@testing-library/react + user-event + jest-dom, `msw/node`.

Tests live in `packages/app/tests/unit/` mirroring `src/` (`engine/`, `auth/`,
`views/`, `api/`), named `<module>.test.ts` or `<component>.test.tsx`, never in
`src/` (the package lints `src` only). Import app code via `@/`.

```bash
pnpm --filter @soat/app test
pnpm --filter @soat/app test:watch
pnpm --filter @soat/app exec vitest run tests/unit/engine/listView.test.tsx
pnpm --filter @soat/app exec vitest run --coverage
```

## Harness (do not duplicate)

| File | Purpose |
|---|---|
| `tests/unit/setup.ts` | jest-dom; MSW start/stop; `cleanup()` + `resetHandlers()` + `localStorage.clear()` after each test |
| `tests/unit/msw/server.ts` | the `server` singleton |
| `tests/unit/msw/handlers.ts` | defaults (`/users/me`, `/users/login`, `/openapi.json`, `/projects`) + `TEST_USER` |
| `tests/unit/fixtures/spec.ts` | `testSpec`, drives the generic engine |
| `tests/unit/testUtils.tsx` | `renderWithAuth(ui)`, `NavProbe` |

## Two kinds of test

**Pure logic** (`specUtils.ts`, `formHelpers.ts`): import and assert, `testSpec`
as input.

**Component / integration**: `renderWithAuth` mounts the real `AuthProvider` and
`NavigationProvider`; auth is a token in `localStorage` plus the default
`/users/me` handler.

```tsx
server.use(http.get('*/api/v1/agents', () => HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])));
const agents = parseModules(testSpec).find((m) => m.tag === 'Agents')!;
renderWithAuth(<><ListView module={agents} spec={testSpec} pathParams={{}} /><NavProbe /></>);
await userEvent.click(await screen.findByRole('button', { name: 'View →' }));
expect(screen.getByTestId('nav-probe')).toHaveTextContent('"mode":"detail"');
```

## Rules

- Wildcard the host: `http.get('*/api/v1/agents/:agent_id', …)` (jsdom resolves
  relative URLs against `http://localhost/`).
- Assert request bodies/headers inside the handler, then `expect` afterwards.
- Observe navigation with `<NavProbe />` (`nav-probe` testid), never a mocked
  navigation context.
- Prefer `findBy*` for anything after a request resolves.
- Rejected session: override `/users/me` → 401. Login failure: password `"wrong"`.
- Coverage stays above ~90% statements; cover happy, error, empty and
  401/403/404 paths for every lib function, view and context branch.
- New module: extend `tests/unit/fixtures/spec.ts`; add a default handler only
  if most tests need it.
