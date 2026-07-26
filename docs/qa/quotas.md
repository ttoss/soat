# QA checklist — quotas

Module docs: [`packages/website/docs/modules/quotas.md`](../../packages/website/docs/modules/quotas.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date       | Surface                                                                                                                              | Result                                                                           | Defects filed                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-25 | live server, dedicated project + disposable "victim" API key, real Bedrock agent (`deepseek.v3.2`)                                   | 30/31 documented behaviors verified                                              | [#703](https://github.com/ttoss/soat/issues/703) — formation update silently drops immutable fields ([#705](https://github.com/ttoss/soat/issues/705))                                    |
| 2026-07-26 | live server, shared project `proj_ck7jvYsjVKI9UHCG`, victim key, priced + unpriced Bedrock agents                                    | regression pass — #703 confirmed fixed, 0 new defects, 8 new checks added        | none ([#713](https://github.com/ttoss/soat/issues/713))                                                                                                                                   |
| 2026-07-26 | live server, shared project `proj_ck7jvYsjVKI9UHCG`, MCP surface, unpriced Bedrock agent (`deepseek.v3.2`), two purpose-built actors | targeted pass on claims the prior two did not exercise — 13 new checks, 1 defect | [#719](https://github.com/ttoss/soat/issues/719) — immutability error renders a null `scope_ref` as `""` ([run report](https://github.com/ttoss/soat/issues/713#issuecomment-5083613032)) |

Enforcement was always scoped via `scope_ref` so no other tenant's traffic could
be blocked.

## CRUD & response contract

- [x] `POST /quotas` → `201` with full documented field set
- [x] `GET /quotas/{id}` → `200`, includes `current_usage`
- [x] `GET /quotas` → list with `data` / `total` / `limit` / `offset`
- [x] `PATCH /quotas/{id}` → `200`, applies `limit` and `mode`
- [x] `DELETE /quotas/{id}` → `204`
- [x] `current_usage` shape for `requests`: `window_key`, `count`, `resets_at`
- [x] `current_usage` is `null` for `tokens` / `cost_usd` quotas
- [x] `current_usage` is `null` in list responses (present only on single GET)
- [x] `calendar_month` window key format `2026-07`, `resets_at` = `2026-08-01T00:00:00.000Z`
- [x] `rolling_1m` window key format `2026-07-25T22:20Z`
- [x] `rolling_1h` window key is hour-level (`2026-07-26T02Z`), `resets_at` at the next hour boundary
- [x] `rolling_24h` window key is day-level (`2026-07-26Z`), `resets_at` at next UTC midnight
- [x] `404 RESOURCE_NOT_FOUND` on GET / PATCH / DELETE of a nonexistent quota
- [x] Pagination via `limit` / `offset` returns correct slices and stable `total`

## Validation

- [x] Uniqueness on `(project, scope, scope_ref, metric, window)` → `409 QUOTA_CONFLICT`
- [x] `scope: agent` + `metric: requests` → `400` (no per-request agent attribution)
- [x] `scope: actor` + `metric: requests` → `400` (`requests` is `project`/`api_key` only)
- [x] `scope: api_key` + `metric: tokens` → `400` (usage carries no key attribution)
- [x] `scope: api_key` + `metric: cost_usd` → `400`
- [x] `limit: 0` → `400`
- [x] `limit: -5` → `400`
- [x] Fractional `limit` allowed for `cost_usd` (`0.05` → `201`)
- [x] Fractional `limit` rejected for `tokens` (`10.5` → `400`, "must be a positive integer")
- [x] Invalid `scope` / `metric` / `window` / `mode` enum → `400`, each naming the valid set
- [x] `scope_ref` pointing at a nonexistent entity → `400`
- [x] `scope_ref` pointing at an entity in a **different** project → `400`
- [x] `scope` / `metric` / `window` rejected on `PATCH` → `400 Unknown field(s)`

## `requests` enforcement (middleware)

- [x] Blocks the request that crosses the limit (limit 3 → 4th request `429`)
- [x] `429` body matches docs exactly: `QUOTA_EXCEEDED`, `quota_id`, `metric`, `limit`, `window`, `resets_at`
- [x] `Retry-After` header present and counting down
- [x] Rejected requests still increment the counter (3 allowed + 3 blocked → `count: 6`)
- [x] Counter resets on window roll, and service is restored on the exact boundary
- [x] `scope_ref` isolation — only the targeted key blocked, sibling key in same project unaffected
- [x] JWT (interactive) requests are **never counted** — counter held across JWT requests
- [x] JWT requests are **never blocked** — `200` while an API key got `429` at the same moment
- [x] Counters dropped on delete — recreate identical quota in the same window → `count: 0`

## `tokens` / `cost_usd` enforcement (pre-generation)

- [x] `tokens` quota blocks a new generation with `429` + correct `meta`
- [x] Aggregate read from the real usage meter (agent's 12 in / 2 out matched `/usage`)
- [x] `tokens` aggregate is uncached input + output + cached — `65 + 11 + 0 = 76` matched `/usage` exactly for the window
- [x] The breach boundary is **at or over**, not over: aggregate `76` against `limit: 76` blocks; against `limit: 77` it is allowed
- [x] Raising the limit via `PATCH` unblocks the next generation immediately
- [x] `cost_usd` blocks on priced usage — metered `0.016` vs limit `0.005` → `429`
- [x] Cost math exact: 12 × 0.001 + 2 × 0.002 = 0.016
- [x] Agent-scoped quota only affects its `scope_ref` agent, not other agents in the project
- [x] Actor-scoped quota with explicit `scope_ref` blocks only the targeted actor
- [x] Actor-scoped quota with `scope_ref: null` gives **one budget per actor**, not a pooled counter
- [x] A generation with **no session** matches no actor quota — two session-less generations both completed under a null-ref `actor` quota with `limit: 1`, where any match at all would have blocked
- [x] A session carrying **no `actor_id`** matches no actor quota — generation allowed under the same quota; the meter row shows `session_id` set and `actor_id` null
- [x] In-flight generation is not killed (overshoot bounded to one generation) — measured: an allowed generation took the aggregate `76` → `121` against `limit: 77`, and the next one blocked

## `cost_usd` unpriced path (the documented fail-open)

- [x] Unpriced window → aggregate 0, generation allowed (fails open, as documented)
- [x] `quota_unpriced` exception filed, severity `warning`
- [x] Exception detail carries `quota_id`, `limit`, `scope`, `scope_ref`, `metric`, `window`, `unpriced_event_count`
- [x] Deduped on the quota rather than per request
- [x] Dedup granularity is **per window**, not per call — `occurrence_count` increments once the next window is entered, not on each unprotected generation
- [x] No exception filed once pricing is effective

## Monitor mode

- [x] `requests` monitor breach does **not** block — 5 requests over a limit of 3, all `200`
- [x] `tokens` monitor breach does **not** block the generation
- [x] `quota.exceeded` webhook fires on monitor breach
- [x] Webhook fires **once per window** (2 breaching requests → 1 delivery)
- [x] On a null-ref `actor` quota the webhook fires once per window **per quota, not per actor** — two different actors breaching in the same `rolling_1h` window produced exactly 1 delivery, while both were still blocked independently. The payload carries no actor identity (`scope_ref: null`), so `group_by=actor` on the meter is the only way to tell who breached
- [x] Webhook `data` carries all 10 documented fields incl. `window_key`, `observed_value`, `mode`
- [x] `quotas:MonitorBreach` audit entry written
- [x] Audit entry has null `principal_type` / `principal_id` (no principal authorized it)
- [x] Audit `detail.kind` = `quota_monitor_breach` with metric, window, limit, observed value
- [x] `observed_value` matches the meter aggregate
- [x] `PATCH mode: monitor → enforce` takes effect on the next breaching request

## Precedence (fail-closed)

- [x] Every matching `enforce` quota is checked; any breach blocks
- [x] Most specific breached scope reported for attribution (`api_key` quota when both match)
- [x] `actor` outranks `agent` — with both breached on one generation the error reported `actor`; deleting the actor quota flipped the report to `agent <ref>`, confirming the top of the `actor` > `agent` > `api_key` > `project` ladder
- [x] Broader quota correctly reported when it is the breached one
- [x] A more specific quota never loosens a broader one

## Auth & permissions

- [x] Unauthenticated → `401`, **not** `429` (middleware sits after auth)
- [x] Invalid bearer token → `401`
- [x] `403` on `GET /quotas` for a key without quota permissions
- [x] `403` on `POST /quotas` for the same key
- [x] `403` on `DELETE /quotas/{id}` for the same key
- [x] Same key still `200` on an action it _is_ granted (proves the key is otherwise live)
- [x] Quota mutations audited: `quotas:CreateQuota`, `quotas:UpdateQuota`, `quotas:DeleteQuota`
- [x] Self-modification footgun reproduces as documented — a project-wide `requests` cap locks the operator's own API key out of quota management until the window rolls. Verified in the 2026-07-25 pass on a dedicated project. The 2026-07-26 retry was inconclusive (the shared project carried concurrent unrelated traffic, so counts were non-deterministic), which is a limitation of that environment rather than a contradiction — re-test on an isolated project if it needs reconfirming

## Soft references

- [x] Quota referencing a deleted-but-undeletable entity stays visible via `GET`
- [x] Such a quota remains deletable through the API (not cascade-deleted)
- [x] Deleting the `scope_ref` entity outright (an API key) leaves the quota visible and deletable, no cascade

## Formation resource

- [x] `quota` resource creates successfully, physical quota materialized
- [x] Unknown field rejected `400` with precise message and allowed-field list
- [x] `limit` update applies through the formation lifecycle
- [x] `mode` update applies through the formation lifecycle
- [x] `scope` / `metric` / `window` rejected on formation **update** — `status: "failed"` with an error naming the field, declared value, and current value; underlying quota unchanged (was [#703](https://github.com/ttoss/soat/issues/703), fixed and re-verified 2026-07-26)
- [x] Restating an immutable field at its **current** value succeeds — all four restated verbatim while `limit`/`mode` changed → `status: "updated"`. This is the path every real template takes, since `scope`/`metric`/`window` are required on create
- [x] **Omitting** `scope_ref` reads as "not supplied", not as clearing it — stored ref preserved and `limit`/`mode` still applied
- [x] An **explicit** `scope_ref: null` that disagrees with the stored ref is rejected as a change
- [x] Each immutable field is guarded **individually** — `scope`, `scope_ref`, `metric`, and `window` each rejected when changed alone, the error naming that field (a single shared guard would pass a combined-change test but fail these)
- [x] A failed update applies **nothing** piecemeal — `limit: 999` / `mode: monitor` in the same rejected template were not applied, and the stored template did not advance
- [x] A formation **recovers** from `status: "failed"` — a subsequent valid update returns it to `active`; no stuck state
- [ ] Immutability error renders a null `scope_ref` as `null` rather than `""` — [#719](https://github.com/ttoss/soat/issues/719). Both directions affected (`declared ""` for a declared null, `current ""` for a stored null). Comparison, rejection, and rollback are all correct; the diagnostic is wrong, and it is wrong precisely where `null` vs. a ref is load-bearing for `actor` scope
- [x] Invalid scope/metric combo rejected at formation **create**, proving the formation module reuses the REST shared validator rather than duplicating it
- [x] Deleting a formation whose template declares a `quota` cascades to the quota (`GET` → `404`)

## Not covered

- [ ] **Multi-replica counter atomicity** (the atomic `UPDATE … RETURNING` claim) — needs a multi-replica deployment; only a single instance was reachable in all three passes.
- [ ] **`reasoning_tokens` exclusion from the `tokens` aggregate** — needs a reasoning model. `deepseek.v3.2` emits no `reasoning_tokens` component (meter rows carry only `input_tokens` / `output_tokens`, and `/usage` reports `reasoning_tokens: 0`), so although the aggregate matched input + output + cached exactly, a zero cannot discriminate whether reasoning tokens would be excluded.
- [ ] **Real-time rollover for `rolling_1h` / `rolling_24h` / `calendar_month`** — would require waiting out the actual window. Only window-key format and `resets_at` were checked. `rolling_1m` rollover _was_ observed for real.

## Observations (not defects)

- `unpriced_event_count` in the `quota_unpriced` exception detail is a first-seen
  snapshot and does not refresh on dedup. The docs don't promise a refresh and
  `occurrence_count` carries the "ran unprotected" signal, so this reads as
  intentional.
- `occurrence_count` is not a literal per-call counter — see the per-window dedup
  item above. Anything relying on it as a call count will be wrong.
- A breach on a null-ref `actor` quota reports `Quota exceeded for actor.` with no
  actor named, because the quota itself carries no `scope_ref`. Consistent with
  the webhook granularity the docs describe, but it means neither the `429` nor
  the webhook identifies _which_ end user was capped.
- The 2026-07-26 targeted pass surfaced a defect in **sessions**, not quotas:
  `POST /sessions` claimed it created two actors when it creates none
  ([#720](https://github.com/ttoss/soat/issues/720), fixed). It matters here
  because every `actor`-scope item above depends on the session carrying an
  `actor_id` — a session created without one silently matches no actor quota, so
  the false claim led the first attempt at those checks to test nothing. Worth
  re-reading when `sessions` gets its own first pass.
