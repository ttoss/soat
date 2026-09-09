# Common Instructions

ttoss ecosystem conventions: https://ttoss.dev/ttoss-instructions.txt

## Code style

- Functions take one `args` object: `const fn = (args: { a: string }) => …`.
- Prefer functions over classes.
- kebab-case folders, camelCase files/variables/functions, PascalCase types,
  UPPER_SNAKE constants, `<file>.test.ts` for tests.
- Comment only for a non-obvious why: hidden constraint, invariant, workaround
  (reference the issue). Never restate the code, leave commented-out code,
  `TODO`/`FIXME`, or task narration. Applies to every package and to tests.
- Lint a file: `pnpm eslint --fix path/to/file`.
- Schema changes: follow `packages/postgresdb/README.md`; a dev database that
  will not `--alter` may be dropped and recreated.
- Docs are English, for developers: concise, code over prose.

## Implementation checklist

1. Business logic in `packages/server/src/lib/<module>.ts`; all DB access there.
2. Routes in `packages/server/src/rest/v1/<module>.ts` with `@openapi` JSDoc;
   spec in `packages/server/src/rest/openapi/v1/<module>.yaml` kept in sync.
   After a spec change: `pnpm --filter @soat/sdk generate` and
   `pnpm --filter @soat/cli generate`. MCP tools derive from the specs at
   runtime (`packages/server/src/lib/soatTools.ts`); never add per-module MCP
   files.
3. Module docs: `packages/website/docs/modules/<module>.md`.
4. Tests in `packages/server/tests/unit/tests/rest/<module>.test.ts`: happy
   path, `401`, `403`, edge cases, for every new route and changed lib function.
5. New user-facing flow: add steps to `tests/smoke-tests.sh`; run
   `pnpm run -w smoke-tests`.
