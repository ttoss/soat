# API Redesign — Decision Log

Working document for the full REST API redesign. The driving goal is **a clean,
non-duplicated surface** — in particular, **no duplicate MCP tools** (MCP tools
are auto-derived from the OpenAPI specs via `soatTools.ts`, so every redundant
path becomes a redundant tool the agent has to choose between).

## Guiding Principles

1. **One canonical path per operation.** No two routes should do the same thing.
2. **A resource with a global ID lives at the top level.** Scoped access is a
   query filter on the top-level collection, not a nested path.
3. **Nested paths are reserved for weak entities** that have no independent
   identity (e.g. tags), where a top-level collection would be meaningless.
4. **Relationships are expressed as fields/filters**, not as nested sub-collections.

## Decisions

### D1 — Collapse scoped actor sub-collections into `/actors`

**Status:** approved · **Modules:** actors, agents, chats, conversations

Remove the nested actor paths; the top-level `/actors` collection absorbs them
via body fields (create) and query filters (list).

| Remove | Replace with |
|---|---|
| `POST /agents/{agent_id}/actors` (`createAgentActor`) | `POST /actors` with `agent_id` in body |
| `POST /chats/{chat_id}/actors` (`createChatActor`) | `POST /actors` with `chat_id` in body |
| `GET /conversations/{conversation_id}/actors` (`listConversationActors`) | `GET /actors?conversation_id=...` |

Notes:
- `agent_id`/`chat_id` are mutually exclusive FK columns on `Actor`; the XOR rule
  already lives in `createActor` (`validateActorExclusivity`). Only the OpenAPI
  `POST /actors` body needs the two fields exposed; the handler resolves
  publicId → internal id (`resolveActorLinkedIds` already exists).
- `conversation_id` is **derived** membership (distinct actors across that
  conversation's `ConversationMessage` rows), not a stored FK. `listActors` needs
  a new join-based filter for it. As an API query param it is still coherent.

Implementation surface (per repo rules): OpenAPI specs → SDK regen → CLI regen →
MCP auto-derived → module docs → tests (REST + mcp.test.ts) → smoke tests.

### D2 — Flatten parent-only strong children to top-level

**Status:** approved · **Modules:** agents/sessions, orchestrations/runs,
memories/entries, webhooks/deliveries

These have no duplicate today (one path each), but for a consistent surface they
are promoted to top-level resources. The parent moves from a path segment to a
**query filter** (list) and a **body field** (create). Sub-resources stay nested
under the new top-level path (e.g. session messages → `/sessions/{id}/messages`).

**Naming rule:** qualify a name *only* when the bare noun is generic or collides;
never qualify for its own sake.

| Nested (remove) | Top-level (canonical) | CLI / MCP |
|---|---|---|
| `/agents/{agent_id}/sessions[/{session_id}]` | `/sessions?agent_id=` · `/sessions/{session_id}` | `getSessions` |
| `/orchestrations/{id}/runs[/{run_id}]` | `/orchestration-runs?orchestration_id=` · `/orchestration-runs/{run_id}` | `getOrchestrationRuns` |
| `/memories/{memory_id}/entries[/{entry_id}]` | `/memory-entries?memory_id=` · `/memory-entries/{entry_id}` | `getMemoryEntries` |
| `/webhooks/{webhook_id}/deliveries[/{delivery_id}]` | `/webhook-deliveries?webhook_id=` · `/webhook-deliveries/{delivery_id}` | `getWebhookDeliveries` |

`sessions` stays bare (single, strong noun). Risk banked: if a second session
type appears, qualifying it later is a breaking rename.

### D3 — Resolve remaining read duplicates via filters

**Status:** approved · **Modules:** policies, generations

Same pattern as D1: a resource reachable two ways collapses to the top-level
collection with a filter.

| Remove | Replace with |
|---|---|
| `GET /users/{user_id}/policies` (`getUserPolicies`) | `GET /policies?user_id=...` |
| `GET /traces/{trace_id}/generations` (`getTraceGenerations`) | `GET /generations?trace_id=...` (add top-level list) |

### D4 — Relationships as fields + filters (one carve-out)

**Status:** approved

- **Reads** of a relationship → query filter on the related collection
  (`GET /policies?user_id=`, `GET /actors?agent_id=`). Never a nested read path.
- **FK / exclusive links** (actor→agent|chat|memory) → body field on
  create/update. Matches D1.
- **Carve-out — policy assignment writes** keep a single dedicated write verb
  (e.g. `PUT /users/{user_id}/policies` or `PUT /policies/{id}/assignments`).
  Rationale: assignment is a privileged action distinct from editing the user,
  with its own permission; it is a write so it never duplicates a read tool.

### D5 — Tags stay nested (weak entities)

**Status:** approved

`*/tags` sub-collections remain nested. Tags have no independent identity; a
top-level `/tags` collection would be meaningless. No change.

### D6 — Action sub-paths stay nested (RPC verbs)

**Status:** approved

`/generate`, `/completions`, `/call`, `/tree`, and run `/cancel|/resume|
/human-input` remain as nested action paths. They are verbs on a specific
resource instance, not resources themselves, and each is single-path (no
duplication). No change.

### D7 — Messages stay nested (join entity, not a resource)

**Status:** approved · **Modules:** conversations, sessions

`ConversationMessage` links `Conversation ↔ Document` plus context (`role`,
`position`, `actorId`, `agentId`, `metadata`) and has **no publicId** — it is
addressed by `(conversation_id, document_id)`. It is a weak/join entity (same
class as tags, D5), so it is **not** promoted to a top-level `/messages`
resource. Keep `/conversations/{id}/messages[/{document_id}]`.

Not a duplicate of `/documents/{id}`: the message carries conversation-context
fields the document lacks, and one document may appear in multiple conversations.

### D8 — Session messaging: drop the duplicate read, keep the writes

**Status:** recommended (read-drop is vetoable — product-facing) · **Module:** sessions

A `Session` wraps a `Conversation` (`Session.conversationId` FK); session message
functions delegate to the conversation's messages.

- **Drop `listAgentSessionMessages`** — a pure projection of
  `listConversationMessages`. The session response already exposes
  `conversation_id`, so a session-scoped read is just
  `GET /conversations/{conversation_id}/messages`. Removes a duplicate MCP tool,
  no behavior loss.
- **Keep `addSessionMessage`, `generateSessionResponse`,
  `submitSessionToolOutputs`** — not duplicates; they enforce session-only
  semantics (status guards closed/expired, actor binding, `messageDelaySeconds`).

## Target Path List

Net change vs. current (152 ops): **−6 removed, +1 new, 23 relocated, 4 schema-modified.**

### New top-level resources (D2)
- `sessions` (from `agents/{id}/sessions`) — `?agent_id=` filter, `agent_id` body
- `orchestration-runs` (from `orchestrations/{id}/runs`) — `?orchestration_id=`
- `memory-entries` (from `memories/{id}/entries`) — `?memory_id=`
- `webhook-deliveries` (from `webhooks/{id}/deliveries`) — `?webhook_id=`

### Removed operations (folded into filters/body)
| Removed | Replaced by |
|---|---|
| `createAgentActor` | `createActor` + `agent_id` body (D1) |
| `createChatActor` | `createActor` + `chat_id` body (D1) |
| `listConversationActors` | `listActors?conversation_id=` (D1) |
| `getUserPolicies` | `listPolicies?user_id=` (D3) |
| `getTraceGenerations` | `listGenerations?trace_id=` (D3) |
| `listAgentSessionMessages` | `listConversationMessages` via session's `conversation_id` (D8) |

### New operation
- `listGenerations` — `GET /generations?trace_id=` (top-level list; `getGeneration` already existed)

### Schema-modified (path unchanged)
- `createActor` (+`agent_id`,`chat_id`), `listActors` (+`agent_id`,`chat_id`,`conversation_id`),
  `listPolicies` (+`user_id`), `listGenerations` (new, +`trace_id`)

### Unchanged modules
ai-providers, api-keys, documents, embeddings, files, formations, knowledge,
projects, secrets, tools — no path changes (tags/actions kept nested per D5/D6).

### D9 — Relocate the stateless completions endpoint out of `/chats`

**Status:** approved · **Module:** chats

Keep both completions operations (they differ: stateless vs stateful), but move
the stateless OpenAI-compatible one out from under the `chats` resource — it does
not touch any chat.

| From | To |
|---|---|
| `POST /chats/completions` (`createChatCompletion`) | `POST /chat/completions` |
| `POST /chats/{chat_id}/completions` (`createChatCompletionForChat`) | unchanged (correctly an action on a chat) |

Final path: **`POST /chat/completions`** (not `/completions`). It is the exact
OpenAI Chat Completions path, so an OpenAI SDK can target it by setting
`base_url` alone. `/completions` is OpenAI's *legacy* (non-chat) endpoint with a
different request shape, so that name would mislead.

### D10 — D8 read-drop confirmed (asymmetry is principled)

**Status:** approved

Drop `listAgentSessionMessages`. The read/write asymmetry (write via session,
read via conversation) is justified: session *writes* carry session-only rules
(closed/expired guards, actor binding, message delay) so they must be
session-scoped; session *reads* have no session-specific logic — they are the
same rows — so they route to the conversation. Not a wart; a principle.

### D11 — Policy assignment: inverse operations, not duplicates; add on demand

**Status:** approved

"Both write paths" is only acceptable if each manages the relationship from its
**own resource's side** (inverse, not the same fact via two doors):

- ✅ `PUT /users/{user_id}/policies` — replace the policy set *on a user*
- ✅ (future) `PUT /policies/{policy_id}/assignments` — replace the user set *on a policy*
- ❌ two endpoints that both mean "attach policy P to user U" — forbidden (the
  duplication this redesign exists to remove)

Decision: keep the user-side write now (`attachUserPolicies`); add the
policy-side inverse only when a per-policy bulk-assign use case appears (YAGNI).
Reads use inverse filters: `GET /policies?user_id=` and `GET /users?policy_id=`.

## Implementation Plan

**Strategy:** single **atomic PR** off `main` (new branch `feat/api-redesign`,
NOT the brand PR #235). **Hard-cut** — old paths are deleted, not deprecated.
SDK + CLI regenerated once after all spec changes land; everything ships together.

### Execution order (all lands in one PR; order minimizes churn)

1. **Lib layer** — make resources addressable without the parent path:
   - `listActors`: add `agentId`/`chatId` filters + `conversationId` (join via
     `ConversationMessage`). `createActor`: already supports agent/chat.
   - `listPolicies`: add `userId` filter. New `listGenerations` (+`traceId`).
   - Sessions/runs/entries/deliveries: refactor lookups to key off the child's
     own global id (e.g. `findSessionRecord` without `agentId`); parent becomes a
     filter/body field. Enforce parent existence on create.

2. **OpenAPI specs** (`rest/openapi/v1/`) — the contract, source of truth:
   - New/relocated top-level paths: `sessions`, `orchestration-runs`,
     `memory-entries`, `webhook-deliveries`; relocate `chat/completions`.
   - Remove the 6 deleted ops; add filters/body fields (D1/D3).

3. **Route handlers** (`rest/v1/`) — new top-level routers for the flattened
   resources; register in `rest/v1/index.ts`; delete old nested routes. Move
   session sub-routes (generate/messages/tags/tool-outputs) under `/sessions`.

4. **Regen** — `pnpm --filter @soat/sdk generate` + `pnpm --filter @soat/cli generate`.
   MCP surface auto-derives from the specs (no manual MCP edits).

5. **Formations sync** — `sessions` and `memory-entries` have formation modules;
   update `SessionResourceProperties` / `MemoryEntryResourceProperties` in
   `formations.yaml` + the modules' `build*Args`/`read`. Add `agent_id`/`chat_id`
   to `ActorResourceProperties`. (runs/deliveries have no formation module.)

6. **Permissions** — regenerate the permissions page; verify action names unchanged
   (operationIds mostly stable, so `actors:CreateActor` etc. carry over).

7. **Docs** — update affected `website/docs/modules/*.md`.

8. **Tests** — update REST tests for moved paths, `mcp.test.ts`, smoke tests.

9. **QA** — `pnpm typecheck`, `pnpm eslint --fix`, `pnpm test`, `pnpm run -w smoke-tests`.

### Constraints / blockers in this environment
- **Server tests can't run here** — sandbox is missing `babel-jest`; `smoke-tests`
  need Docker + a live server. Code + tests get written, but server-side
  verification likely happens in CI / the user's env.
- **App impact** — the app engine builds its UI generically from the live spec
  (`specUtils.parseModules`), so the flattening changes app nav. App unit tests
  use a fixture spec, so they won't break automatically — manual check needed.
- Pagination/filter consistency pass across all top-level list endpoints
  (`limit`/`offset`/`total` shape) once flattening lands.

## Implementation Progress

- **D1 (actors)** — done.
- **D2/D8/D10 (sessions)** — done: flattened to top-level `/sessions`, sub-routes
  relocated, `listAgentSessionMessages` dropped, lib/routes/spec/permissions/
  module-doc/unit+MCP tests updated. Formation needed no change (it self-resolves
  the agent id). Permission actions kept as `agents:*` (renaming policy actions is
  out of scope for a path redesign).
- **D2 (orchestration-runs)** — done: `/orchestrations/{id}/runs` →
  `/orchestration-runs`; run-action libs already accepted optional
  orchestrationPublicId, only listOrchestrationRuns relaxed. Smoke updated.
- **D2 (memory-entries)** — done: `/memories/{id}/entries` → `/memory-entries`;
  list requires `?memory_id=` (no project column on entries). Formations already
  memory_id-based, no change.
- **D2 (webhook-deliveries)** — done: `/webhooks/{id}/deliveries` →
  `/webhook-deliveries`; list requires `?webhook_id=`; delivery responses now
  carry `webhook_id`.
- **Deferred to a final batched pass** (tracked): tutorial updates (renamed CLI
  commands / removed endpoints) and the generated reference docs
  (api/mcp/sdk/cli). Tutorials need Docker tutorial CI to validate, so they run
  once at the end rather than per-slice.

Remaining slices: D3 (generations/traces), D3/D4/D11 (policies/users), D9 (chats
completions), then the batched tutorials/docs pass.
