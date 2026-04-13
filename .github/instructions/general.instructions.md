---
applyTo: '**'
description: Common instructions that apply to all parts of the codebase.
---

# Common Instructions

These instructions are essential for ensuring that agents add the correct instructions when modifying or creating code in the codebase.

## Function Arguments

When defining functions, use an object for arguments instead of individual parameters: `const myFunction = (args: { arg1: string }) => { ... }`.

## Functions vs Classes

Prefer using functions instead of classes for better simplicity and composability.

## Naming Conventions

- User kebab-case for folder names (e.g., `my-folder`).
- Use camelCase for file names (e.g., `myFile.ts`).
- Use camelCase for variable and function names (e.g., `myVariable`, `myFunction`).
- Use PascalCase for type and interface names (e.g., `MyType`, `MyInterface`).
- Use uppercase with underscores for constants (e.g., `MY_CONSTANT`).
- For test files, use the same name as the file being tested with `.test` appended before the extension (e.g., `myFile.test.ts`).

## Linting

To fix ESLint issues in a specific file, run `pnpm eslint --fix path/to/file`.

## Database

If you need to change the database schema, read the instructions in `packages/postgresdb/README.md` about how to sync the database schema. You can remove the dev database and start a new one if sync with `--alter` does not work.

## Documentation

All documentation must be written in English. The target audience is developers with technical skills — write concisely and precisely, assume familiarity with REST APIs, JWT, and common backend concepts, and prefer code examples over prose descriptions.

## Implementation Checklist

Every implementation — whether adding a new feature or changing existing behavior — must complete all of the following steps before being considered done:

1. **Implement business logic** — Write or update code in `packages/server/src/lib/<module>.ts`. All database access goes here; route handlers must stay free of direct DB calls.

2. **REST API** — Add or update route handlers in `packages/server/src/rest/v1/<module>.ts`. Every handler must have an `@openapi` JSDoc block and the corresponding OpenAPI spec in `packages/server/src/rest/openapi/v1/<module>.yaml` must be kept in sync.

3. **Module docs** — Update the module documentation page at `packages/website/docs/modules/<module>.md`, including any changes to the data model, key concepts, or the `## Permissions` table.

4. **MCP tool** (project-scoped changes only) — If the change affects a resource that is exposed through the MCP server, add or update the tool in `packages/server/src/mcp/tools/<module>.ts` and ensure it is registered in `packages/server/src/mcp/tools/index.ts`.

5. **Tests** — Add or update tests in `packages/server/tests/unit/tests/<module>.test.ts`. Every new route and every changed lib function must have coverage (happy path, `401`, `403`, and relevant edge cases).

6. **Smoke test** (when applicable) — If the change introduces a new user-facing flow (e.g., a new resource lifecycle), add the corresponding steps to `tests/smoke-test.sh`. Run it with `pnpm run -w smoke-test` to verify end-to-end behaviour against a live server.
