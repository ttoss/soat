# Quality Assurance

## Red/green TDD

Every fix and feature: write a failing test first and confirm it fails for the
right reason, then the minimum production code to pass, then refactor. No
production code before a red test.

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
