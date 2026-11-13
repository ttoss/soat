# Quality Assurance

## Red/green TDD

Every fix and feature: write a failing test first and confirm it fails for the
right reason, then the minimum production code to pass, then refactor. No
production code before a red test.

## Fixing a bug

Fix the class, not the instance:

1. Name the mechanism that let it in: a check each site must remember to
   call, a path around the chokepoint, a special case keyed by id, a copy that
   drifted (`duplicated-knowledge.md`).
2. Remove the mechanism: enforce at the one chokepoint every path crosses,
   make the safe path the only one the types accept (a required argument, no
   cast), dispatch through a registry instead of a branch per case, and fail
   closed on what nothing recognises.
3. Add the test that fails when a new site brings the mechanism back:
   structure in `tests/harness/`, behavior at the entry point.
4. When the structural fix is out of the change's scope, land the patch and
   file the structural fix as its own task, linked to it.

## Definition of done

From the package root (`packages/server`, etc.), all must pass:

```bash
pnpm typecheck
pnpm eslint --fix
pnpm test
pnpm run -w smoke-tests   # from the workspace root
```

## Type safety

`as any` and `as unknown` are forbidden. Fix the type, narrow (`typeof`, `in`,
`Array.isArray`), use generics or a type guard; validate external data at
runtime. Check: `grep -r " as any\| as unknown" src/ --include="*.ts"`.

## Coverage

Every public lib function and REST route: happy path, `401`, `403`, edge cases.
Single file: `pnpm test --testPathPatterns=<module>.test.ts`. Patterns in
`tests.md`.

## Checklist

- [ ] `pnpm typecheck` clean, no `as any` / `as unknown`
- [ ] `pnpm eslint --fix` clean
- [ ] `pnpm test` green, no skipped tests
- [ ] `pnpm run -w smoke-tests` green
- [ ] No `console.log` or `debugger`
