# Common Instructions

ttoss ecosystem conventions: https://ttoss.dev/ttoss-instructions.txt

## Code style

- Functions take one `args` object: `const fn = (args: { a: string }) => …`.
- Prefer functions over classes.
- kebab-case folders, camelCase files/variables/functions, PascalCase types,
  UPPER_SNAKE constants, `<file>.test.ts` for tests.
- Comment only for a non-obvious why (hidden constraint, invariant,
  workaround), stated as the constraint, never an issue number or what changed
  (`no-history.md`). No restated code, commented-out code, `TODO`/`FIXME` or
  task narration, in every package and in tests.
- Lint a file: `pnpm eslint --fix path/to/file`.
- **Module ceiling: 400 code lines** (`max-lines` in `eslint.config.js`; blanks
  and comments not counted). Over it, split the module; never disable the rule
  inline. Existing offenders are in `MAX_LINES_EXEMPT` there;
  `tests/harness/moduleCeiling.test.mjs` keeps the list shrinking.
- Schema changes: follow `packages/postgresdb/README.md`; a dev database that
  will not `--alter` may be dropped and recreated.
- Docs are English, for developers: concise, code over prose.

## Implementation checklist

1. Business logic in `packages/server/src/lib/<module>.ts`; all DB access there.
   A file or document saved on the caller's behalf goes under
   `/.system/<module>/` through `systemPath` (`lib/filePaths.ts`), never a
   caller path; every caller-supplied path goes through `assertCallerPath`.
2. Routes in `packages/server/src/rest/v1/<module>.ts` with `@openapi` JSDoc;
   spec in `packages/server/src/rest/openapi/v1/<module>.yaml` kept in sync.
   After a spec change: `pnpm --filter @soat/sdk generate` and
   `pnpm --filter @soat/cli generate`. Never add per-module MCP files; tools
   derive from the specs (`packages/server/src/lib/soatTools.ts`).
3. Module docs: `packages/website/docs/modules/<module>.md`.
4. Tests in `packages/server/tests/unit/tests/rest/<module>.test.ts`: happy
   path, `401`, `403`, edge cases, for every new route and changed lib function.
5. New user-facing flow: a tutorial that runs it, or steps in
   `tests/smoke-tests.sh` when no tutorial can (`e2e-tests.md` §Smoke tests);
   run `pnpm run -w smoke-tests`.

Cutting or merging a release: read `.claude/rules/release.md` first.
