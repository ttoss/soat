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

## Linting

To fix ESLint issues in a specific file, run `pnpm eslint --fix path/to/file`.
