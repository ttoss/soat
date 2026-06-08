# Quality Assurance Standards

Every implementation is complete only when **all** of the following checks pass without errors or warnings.

## Test-Driven Development (Red/Green)

All fixes and new features **must** follow red/green TDD:

1. **Red** — Write a failing test that reproduces the bug or specifies the new behavior. Run it and confirm it fails for the right reason before writing any production code.
2. **Green** — Write the minimum production code to make the test pass. Run the test again and confirm it is now green.
3. **Refactor** — Clean up without breaking the green test.

Never write production code before a failing test exists. A fix without a red test first is incomplete.

## Definition of Done

Run these commands from the relevant package root (`packages/server`, etc.):

```bash
# TypeScript typechecking
pnpm typecheck

# Linting (auto-fixes where possible)
pnpm eslint --fix

# Unit tests
pnpm test

# Smoke tests (end-to-end, run from workspace root)
pnpm run -w smoke-tests
```

All four must pass. If any fail, the implementation is incomplete.

## TypeScript Type Safety

### No `as any` or `as unknown`

These are **strictly forbidden**. They disable type checking and hide bugs. Fix the root cause instead:

- **Improve the type definition** — add return types, fix interfaces
- **Use type narrowing** — `typeof`, `in`, `Array.isArray`, etc.
- **Use generics** — let the compiler infer or require explicit types
- **Add type guards** — `function isUser(obj: unknown): obj is User { ... }`

For external/dynamic data (API responses, DB rows), use runtime validation or discriminated unions rather than casting.

To check for violations before committing:

```bash
grep -r " as any\| as unknown" src/ --include="*.ts"
```

## Testing

Every public lib function and REST route must have coverage:

- **Happy path** — correct status codes and response shape
- **401** — unauthenticated requests
- **403** — insufficient permissions
- **Edge cases** — missing resources, invalid inputs

Run a specific test file:

```bash
pnpm test --testPathPatterns=<module>.test.ts
```

See `tests.instructions.md` for patterns and helpers.

## Smoke Tests

After adding or changing a user-facing flow, add the corresponding steps to `tests/smoke-tests.sh` and verify end-to-end against a live server:

```bash
pnpm run -w smoke-tests
```

The script uses `set -e` and exits on the first failure. See `tests.instructions.md` for patterns.

## Implementation Checklist

- [ ] `pnpm typecheck` passes — no errors, no `as any` / `as unknown`
- [ ] `pnpm eslint --fix` passes — no lint warnings
- [ ] `pnpm test` passes — all unit tests green, no skipped tests
- [ ] `pnpm run -w smoke-tests` passes — end-to-end flows verified
- [ ] No `console.log` or `debugger` statements left in code
