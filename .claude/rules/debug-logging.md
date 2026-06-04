---
paths:
  - "packages/server/src/**"
---

# Debug Logging

This project uses the [`debug`](https://github.com/debug-js/debug) npm package for operational logging. Do **not** use `console.log` or `console.debug` in production code.

## Namespace Convention

Every module that needs logging gets its own `debug` namespace under `soat:`:

```
soat:<module>
```

Examples already in the codebase:

| File                         | Namespace         |
| ---------------------------- | ----------------- |
| `src/lib/actors.ts`          | `soat:actors`     |
| `src/lib/agentGeneration.ts` | `soat:generation` |
| `src/lib/agentKnowledge.ts`  | `soat:knowledge`  |

## Setup

Add these two lines at the top of the file, after any third-party imports and before your own imports:

```ts
import createDebug from 'debug';

const log = createDebug('soat:<module>');
```

## Where to Log

Add log statements at the **entry point** of every exported lib function and at every significant branching point:

```ts
export const createActor = async (args: { ... }) => {
  log(
    'createActor: projectId=%d name=%s autoCreateMemory=%s',
    args.projectId,
    args.name,
    args.autoCreateMemory
  );

  // ... business logic ...

  log('createActor: created actor id=%s', actor.publicId);
  return mapActor(actor);
};
```

Useful branch points to log:

- Auto-creation of linked resources (e.g., "auto-creating memory for actor name=%s")
- Result of a `findOrCreate` call (`created=%s`)
- Early returns due to invalid input combinations
- Resolved IDs after a DB lookup (`resolved memoryId=%d`)

## Log Format

Use `printf`-style format strings — `debug` supports them natively:

| Specifier | Use for             |
| --------- | ------------------- |
| `%s`      | Strings, IDs        |
| `%d`      | Numbers             |
| `%o`      | Objects / arrays    |
| `%O`      | Objects (multiline) |

Keep each log line short and self-describing. Prefix with the function name:

```ts
log('findOrCreateActor: actor=%s created=%s', actor.publicId, created);
log('deleteActor: id=%s', args.id);
log(
  'updateActor: id=%s name=%s memoryId=%s',
  args.id,
  args.name,
  args.memoryId
);
```

## Enabling Logs at Runtime

Set the `DEBUG` environment variable before starting the server or running tests:

```sh
# Single module
DEBUG=soat:actors pnpm --filter @soat/server dev

# All soat modules
DEBUG=soat:* pnpm --filter @soat/server dev

# All modules including third-party
DEBUG=* pnpm --filter @soat/server dev
```

## What NOT to Do

- Do **not** use `console.log` / `console.debug` / `console.info` in lib or route handler code — use the `log` helper instead.
- Do **not** log sensitive values (passwords, tokens, secret keys).
- Do **not** log inside test files — if you need to diagnose test failures, add server-side debug logging to the lib instead.
- Do **not** create a new namespace per function — one namespace per module file is enough.
