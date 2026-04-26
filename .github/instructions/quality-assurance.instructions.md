---
applyTo: '**'
description: Quality assurance standards including TypeScript type safety, testing, linting, and typechecking requirements.
---

# Quality Assurance Standards

This document defines the minimum quality standards that **must be met** before any implementation is considered complete. All implementations must pass tests, linting, and TypeScript typechecking without warnings or unsafe type assertions.

## Core Requirement: All Checks Must Pass

After **every implementation**, you must verify that all of the following commands pass **without errors or warnings**:

```bash
# TypeScript typechecking (from the package root)
pnpm typecheck

# Linting (fixes issues where possible)
pnpm eslint --fix

# Unit tests (run from the package root)
pnpm test
```

These commands form the **Definition of Done**. If any of these fail, the implementation is incomplete.

## TypeScript Type Safety

### No Type Assertions with `as any` or `as unknown`

Type assertions like `as any`, `as unknown`, and similar escape hatches **are strictly forbidden**. These undermine TypeScript's type safety and hide bugs.

**Why?**

- `as any` disables all type checking for that value — the compiler cannot catch errors
- `as unknown` is often used as a stepping stone to `as any`
- These patterns indicate incomplete type definitions or misunderstandings of the data model
- They make code harder to maintain and debug

**What to do instead:**

1. **Improve the type definition** — If a variable doesn't have the right type, fix the source.

   ```ts
   // ❌ WRONG
   const data = someValue as any;

   // ✅ RIGHT
   interface SomeValueData {
     id: string;
     name: string;
   }
   const data: SomeValueData = someValue;
   ```

2. **Use type narrowing** — Check the actual type before using it.

   ```ts
   // ❌ WRONG
   const result = (response.data as any).items;

   // ✅ RIGHT
   if ('data' in response && Array.isArray(response.data.items)) {
     const items = response.data.items;
   }
   ```

3. **Use generics** — Let the compiler infer or require explicit types.

   ```ts
   // ❌ WRONG
   function parse(value: any): any {
     return JSON.parse(value as any);
   }

   // ✅ RIGHT
   function parse<T>(value: string): T {
     return JSON.parse(value);
   }
   ```

4. **Add type guards** — Create functions that verify the shape at runtime.

   ```ts
   // ❌ WRONG
   const user = apiResponse as any;

   // ✅ RIGHT
   function isUser(obj: unknown): obj is User {
     return (
       typeof obj === 'object' && obj !== null && 'id' in obj && 'email' in obj
     );
   }

   if (isUser(apiResponse)) {
     const user = apiResponse; // Now typed as User
   }
   ```

### Handling External/Dynamic Data

When data comes from external sources (API responses, user input, database), use discriminated unions or runtime validation:

```ts
// Parse JSON and validate structure
interface ValidatedData {
  id: string;
  name: string;
}

function validateData(raw: unknown): ValidatedData {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Expected an object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== 'string' || typeof obj.name !== 'string') {
    throw new Error('Invalid data shape');
  }

  return { id: obj.id, name: obj.name };
}
```

### Checking for Type Assertion Violations

Before committing, search for unsafe patterns:

```bash
# Search for forbidden type assertions in a file or folder
grep -r " as any\| as unknown\| as const\b" src/ --include="*.ts" --include="*.tsx"
```

If these appear, fix them during implementation.

## Testing Requirements

Every implementation **must include test coverage**:

- **Happy path** — The feature works as intended
- **Error cases** — Invalid inputs, missing data, permission denials
- **Edge cases** — Empty arrays, null values, boundary conditions

Run tests with:

```bash
pnpm test
```

Tests must pass with no skipped or flaky tests. If a test is flaky, fix the underlying issue rather than adding retries.

### Running Tests for Specific Files

```bash
pnpm test --testPathPatterns=<module>.test.ts
```

For more details, see `tests.instructions.md`.

## Linting Requirements

All code must pass ESLint checks. The linter catches:

- Unused variables
- Missing semicolons (if configured)
- Inconsistent naming
- Accessibility issues
- Security concerns

Fix linting issues **during development**, not as an afterthought:

```bash
# Fix issues automatically (where possible)
pnpm eslint --fix

# Check without fixing
pnpm eslint src/
```

If ESLint has a false positive or the rule doesn't apply, use an inline comment:

```ts
// eslint-disable-next-line no-unused-vars
const temporaryValue = computeSomething();
```

But prefer fixing the underlying issue instead of disabling rules.

## TypeScript Checking

TypeScript must pass without errors or warnings:

```bash
pnpm typecheck
```

This command:

- Checks all `.ts` and `.tsx` files
- Ensures all imports are valid
- Verifies types are correct and complete
- Catches unused variables and unreachable code

### Fixing TypeScript Errors

If `pnpm typecheck` reports an error:

1. **Read the error carefully** — It usually points to the exact line and problem
2. **Understand the type mismatch** — Why does the compiler think the types don't match?
3. **Fix the root cause** — Don't use `as any`; improve the type definition

### Common TypeScript Fixes

**Missing type definition:**

```ts
// Error: Object is of type 'unknown'
const user = getUserFromDB();

// Fix: Add return type to the function
function getUserFromDB(): User {
  // ...
}
```

**Incorrect property access:**

```ts
// Error: Property 'email' does not exist on type 'User'
console.log(user.email);

// Fix: Check if the property exists or adjust the type
if ('email' in user) {
  console.log(user.email);
}
```

**Array type mismatch:**

```ts
// Error: Type 'string' is not assignable to type 'number[]'
const numbers: number[] = ['1', '2', '3'];

// Fix: Use the correct type or convert
const numbers: string[] = ['1', '2', '3'];
// OR
const numbers: number[] = ['1', '2', '3'].map(Number);
```

## Implementation Checklist

Before submitting or marking work as complete:

- [ ] **TypeScript typechecks** — `pnpm typecheck` passes with no errors or warnings
- [ ] **No `as any` or `as unknown`** — Search and verify these patterns are absent
- [ ] **Linting passes** — `pnpm eslint` shows no issues (use `pnpm eslint --fix` to auto-fix)
- [ ] **All tests pass** — `pnpm test` completes successfully
- [ ] **All new functions have tests** — Happy path, error cases, and edge cases covered
- [ ] **Error handling is complete** — No silent failures or unhandled promises
- [ ] **No console.log or debugger statements** — Use proper logging instead

## Continuous Monitoring

During development, keep a terminal running to watch for issues:

```bash
# Watch for TypeScript errors (from the package root)
pnpm typecheck --watch

# Watch for test failures (from the package root)
pnpm test --watch
```

Many IDEs (VS Code, WebStorm) also provide real-time TypeScript checking.

## Why These Standards Matter

- **Type safety prevents runtime errors** — Catching bugs at compile time is cheaper than at runtime
- **Testing ensures reliability** — Users depend on the system working correctly
- **Linting maintains consistency** — Code is easier to read and maintain when it follows conventions
- **No escape hatches** — `as any` hides problems; enforcing type safety makes code reliable

## Exceptions

There are **no blanket exceptions** to these standards. If a specific case genuinely requires exceptional handling:

1. **Document why** — Add a comment explaining the unusual situation
2. **Use a specific assertion** — Not `as any`; use a more precise type if possible
3. **Get a second opinion** — Have another developer review and approve before committing

Example of acceptable (with justification):

```ts
// The external API returns inconsistent types; we validate at runtime
function handleExternalResponse(data: Record<string, unknown>) {
  if (typeof data.id === 'string') {
    return data.id;
  }
  throw new Error('Invalid response format');
}
```

Example of unacceptable:

```ts
// ❌ No justification; just silences the compiler
const value = data as any;
```
