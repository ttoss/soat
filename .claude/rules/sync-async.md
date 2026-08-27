---
paths:
  - "packages/server/**"
  - "packages/website/**"
---

# Synchronous vs Asynchronous Execution

Any operation that can outlast a request — an LLM generation, an ingestion, a run —
is controlled by **one** toggle, named **`wait`**, with **one** polarity and **one**
default.

```
wait omitted / false  →  background, answer immediately with a handle to poll
wait: true            →  block until it settles, answer with the result
```

There is no second spelling. `async` is retired: it was the same knob with the
opposite polarity, so `async=true` and `wait=true` meant opposite things on
neighbouring endpoints (#965).

## Adding the toggle to a new endpoint

1. **Name it `wait`.** Never `async`, `sync`, `blocking`, or `background`.
2. **Default to background** — `default: false`, and never `required: true`.
   A caller who omits it gets the background mode, on every endpoint.
3. **Pick the surface by what the endpoint does**, which also fixes the status code:

   | The endpoint… | `wait` goes in | Background | Blocking |
   | --- | --- | --- | --- |
   | acts on an existing resource (generate, ingest) | the **query string** | `202 Accepted` | `200` (or `201` when it also creates one) |
   | creates a run (orchestration, eval) | the **request body** | `201 Created`, `status: queued` | `201 Created`, terminal status |

4. **Return a usable handle.** The background response must carry an id the caller
   can poll, and the record behind it must already exist when the response is
   written — a handle that races its own row 404s on the first poll.
5. **Keep the checks synchronous.** Auth, validation, resource resolution, quota
   admission and the record write all happen *before* the accepted response.
   Backgrounding defers the slow part, never a rejection: a bad request must be a
   `4xx`, not a failure the caller can only discover by polling.

## Two interactions that are already decided

- **`stream: true` implies waiting.** A stream holds the request open by
  definition. `stream: true` with `wait=false` is contradictory and must be
  rejected with `400 VALIDATION_FAILED`, not silently resolved either way.
- **A `soat` tool call always waits.** A tool call is one request returning one
  result, with no channel to poll later, so a nested agent-to-agent call must
  block. Mark the parameter `x-soat-tool-forced: 'true'` in the spec: the value is
  pinned server-side and the field is hidden from the tool schema — the same
  treatment as `stream`. This is per-parameter, so only mark the endpoints where a
  tool caller genuinely cannot poll.

## Where this is enforced

| Layer | What it catches |
| --- | --- |
| `packages/server/tests/unit/tests/rest/waitToggleContract.test.ts` | a spec that reintroduces `async`, declares a non-background default, makes `wait` required, or omits the `202` a query-param endpoint's callers poll on |
| `scripts/docs-lint.mjs` | docs that document the retired `?async=` / `--async` spelling |

Both run in CI. The contract test reads the OpenAPI specs, which are the single
source of truth for REST, the SDK, the CLI and the MCP tool surface, so one check
covers every generated client.

## Where it is documented

`packages/website/docs/advanced/sync-and-async.md` is the canonical page for
users — the toggle, the per-endpoint handle table, the status-code split, and how
to choose a mode. Module pages describe **their own handle** and link there for
the rule; do not restate the contract in a module page. Four of them had each
grown their own copy before that page existed, which is how the evaluations row
went stale within hours of Phase 2 shipping.

When you add or change a `wait` endpoint, update that page's tables in the same
change — a stale claim there is worse than no page, because it is the page other
docs point at.
