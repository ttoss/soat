# Common Instructions

ttoss ecosystem conventions: https://ttoss.dev/ttoss-instructions.txt

## Code style

- Functions take one `args` object: `const fn = (args: { a: string }) => …`.
- Prefer functions over classes.
- kebab-case folders, camelCase files/variables/functions, PascalCase types,
  UPPER_SNAKE constants, `<file>.test.ts` for tests.
- Comment only for a non-obvious why: hidden constraint, invariant, workaround
  — state the constraint itself, never an issue number or what changed
  (`no-history.md`). Never restate the code, leave commented-out code,
  `TODO`/`FIXME`, or task narration. Applies to every package and to tests.
- Lint a file: `pnpm eslint --fix path/to/file`.
- **Module ceiling: 400 code lines** (`max-lines` in `eslint.config.js`; blanks
  and comments not counted). Over it, split the module — never disable the rule
  inline. The files already over it are listed in `MAX_LINES_EXEMPT` in that
  file; `tests/harness/moduleCeiling.test.mjs` keeps the list shrinking.
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
