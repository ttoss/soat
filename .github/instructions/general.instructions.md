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

All documentation must be written in English.
