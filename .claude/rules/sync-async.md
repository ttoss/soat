---
paths:
  - "packages/server/**"
  - "packages/website/**"
---

# Sync vs Async

Any operation that can outlast a request has one toggle, `wait`:

```
wait omitted / false  →  background; answer immediately with a pollable handle
wait: true            →  block until settled; answer with the result
```

`async` is retired (#965); never `async`, `sync`, `blocking`, `background`.

## Adding it to an endpoint

1. `wait`, `default: false`, never `required: true`.
2. Surface and status by what the endpoint does:

   | Endpoint | `wait` in | Background | Blocking |
   |---|---|---|---|
   | acts on an existing resource | query string | `202` | `200` (`201` if it also creates) |
   | creates a run | request body | `201`, `status: queued` | `201`, terminal status |

3. The background response carries an id whose record already exists.
4. Auth, validation, resolution, quota admission and the record write happen
   before the accepted response; a bad request is a `4xx`, never a polled
   failure.

## Fixed interactions

- `stream: true` with `wait=false` → `400 VALIDATION_FAILED`.
- A `soat` tool call always waits: mark the parameter
  `x-soat-tool-forced: 'true'` (pinned server-side, hidden from the tool
  schema) only on endpoints a tool caller cannot poll.

## Enforcement and docs

`tests/unit/tests/rest/waitToggleContract.test.ts` (reintroduced `async`,
non-background default, required `wait`, missing `202`) and
`scripts/docs-lint.mjs` (retired `?async=` / `--async` in docs).

`packages/website/docs/advanced/sync-and-async.md` is the canonical user page;
update its tables with every `wait` change. Module pages describe their own
handle and link there; they never restate the contract.
