# Contributing to SOAT

Issues and pull requests are welcome.

## Licensing of contributions

SOAT is licensed under the [Apache License 2.0](./LICENSE). Per section 5 of
that license, any contribution you intentionally submit for inclusion in the
work is licensed under the same terms — inbound equals outbound. There is no
CLA, and you keep the copyright to your work.

Only submit code you have the right to license this way. If you wrote it for an
employer, make sure they allow the contribution.

The name is treated separately from the code: see [TRADEMARK.md](./TRADEMARK.md).

## Project posture

Worth knowing before you invest time in a contribution:

- **SOAT is not monetized.** There is no paid tier, no enterprise edition, and
  no feature withheld from this repository. Everything the README describes
  ships in what you clone. No paid tier is planned.
- **The maintainers earn their revenue elsewhere**, from commercial products
  built on top of SOAT. That is why SOAT itself does not need to be monetized.
  It also means SOAT gets real production use, and that a capability sometimes
  lands here first because a downstream product needed it.
- **Runtime behavior belongs in SOAT.** If something executes, gates, records,
  schedules, or streams, it belongs here as a primitive rather than being
  reimplemented by each consumer. That boundary is what keeps this repository
  worth building on.

## Before you open a pull request

Run the checks for the package you touched — usually `packages/server`:

```bash
pnpm typecheck                                                    # no errors
pnpm eslint --fix                                                 # no warnings
pnpm --filter @soat/server test --testPathPatterns=<module>.test.ts
pnpm run -w smoke-tests                    # only if you changed a user-facing flow
```

The full server suite is slow locally. Run the files for the module you changed
and let CI run the rest.

### Non-negotiables

- **Tests first.** Fixes and features follow red/green: write a failing test
  that reproduces the bug or specifies the behavior, confirm it fails for the
  right reason, then write the code that makes it pass. A fix with no red test
  is incomplete.
- **No `as any` or `as unknown`.** Fix the type instead — narrow it, add a type
  guard, or improve the definition.
- **Never mock what you own.** Tests run against a real PostgreSQL
  testcontainer. Mock only external I/O that cannot run in CI: LLM calls,
  outbound HTTP, email.
- **snake_case on the wire, camelCase inside.** Lib mappers convert explicitly,
  field by field, at one boundary. Never write a function that walks a JSON
  value and rewrites its keys.
- **No `console.log` or `debugger` left in the code.**

## Changing a module

A module is a resource exposed through REST, MCP, the CLI, the SDK, and the
docs. They move together:

1. Business logic in `packages/server/src/lib/<module>.ts`. All database access
   lives here — route handlers stay free of direct DB calls.
2. Routes in `packages/server/src/rest/v1/<module>.ts` with `@openapi` JSDoc
   blocks, registered in `rest/v1/index.ts`.
3. OpenAPI spec in `packages/server/src/rest/openapi/v1/<module>.yaml` — the
   source of truth for the SDK, the CLI route manifest, and the MCP tool
   surface.
4. Regenerate the clients: `pnpm --filter @soat/sdk generate` and
   `pnpm --filter @soat/cli generate`.
5. Permissions in `packages/server/src/permissions/<module>.json`, then
   `pnpm --filter @soat/website generate-permissions-page`.
6. Docs in `packages/website/docs/modules/<module>.md`.
7. Tests in `packages/server/tests/unit/tests/`.

MCP tools are derived automatically from the OpenAPI specs — do not hand-write
per-module MCP tool files for REST-backed resources.

## Pull requests

PR titles are conventional commits, linted in CI:

```
<type>(<scope>): <description>
```

`type` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
`ci`, `chore`, `revert`, `style`. Add `!` before the colon for a breaking
change. Pull requests are squash-merged, so the title becomes the commit subject
on `main` and determines the version bump.

CI runs docs lint, build, a four-way sharded server test matrix with merged
coverage thresholds, smoke tests, and tutorials tests. All of them must pass.

## Where the rest of the rules live

`.claude/rules/` holds the full working rules for this repository — testing,
module structure, case conventions, synchronous versus asynchronous execution,
documentation, and releases. They are written for AI agents working in the repo,
but they are the same rules a human contributor follows, in more detail than
this page.
