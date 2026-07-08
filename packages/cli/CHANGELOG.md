# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.14.3](https://github.com/ttoss/soat/compare/v0.14.2...v0.14.3) (2026-07-08)

**Note:** Version bump only for package @soat/cli

## [0.14.2](https://github.com/ttoss/soat/compare/v0.14.1...v0.14.2) (2026-07-08)

**Note:** Version bump only for package @soat/cli

## [0.14.1](https://github.com/ttoss/soat/compare/v0.14.0...v0.14.1) (2026-07-07)

**Note:** Version bump only for package @soat/cli

# [0.14.0](https://github.com/ttoss/soat/compare/v0.13.20...v0.14.0) (2026-07-05)

**Note:** Version bump only for package @soat/cli

## [0.13.20](https://github.com/ttoss/soat/compare/v0.13.19...v0.13.20) (2026-07-05)

**Note:** Version bump only for package @soat/cli

## [0.13.19](https://github.com/ttoss/soat/compare/v0.13.18...v0.13.19) (2026-07-04)

* feat(agents)!: normalize reasoning pipeline to a single branches/rounds primitive (#390) ([6d7a7fa](https://github.com/ttoss/soat/commit/6d7a7faecddde711c804df84749686298384a755)), closes [#390](https://github.com/ttoss/soat/issues/390) [#388](https://github.com/ttoss/soat/issues/388)

### BREAKING CHANGES

* `kind`, `count`, and `perspectives` are removed from the
reasoning step schema; existing configs using them are rejected with
INVALID_REASONING_CONFIG. Use `branches` instead.

## [0.13.18](https://github.com/ttoss/soat/compare/v0.13.17...v0.13.18) (2026-07-03)

**Note:** Version bump only for package @soat/cli

## [0.13.17](https://github.com/ttoss/soat/compare/v0.13.16...v0.13.17) (2026-07-03)

**Note:** Version bump only for package @soat/cli

## [0.13.16](https://github.com/ttoss/soat/compare/v0.13.15...v0.13.16) (2026-07-03)

**Note:** Version bump only for package @soat/cli

## [0.13.15](https://github.com/ttoss/soat/compare/v0.13.14...v0.13.15) (2026-07-03)

**Note:** Version bump only for package @soat/cli

## [0.13.14](https://github.com/ttoss/soat/compare/v0.13.13...v0.13.14) (2026-07-02)

### Bug Fixes

* **formations:** accept parameters on validate-formation ([#338](https://github.com/ttoss/soat/issues/338)) ([dcd0cd5](https://github.com/ttoss/soat/commit/dcd0cd56f4a128bc923b4325c115c3acb5a94f36)), closes [#319](https://github.com/ttoss/soat/issues/319)

## [0.13.13](https://github.com/ttoss/soat/compare/v0.13.12...v0.13.13) (2026-07-02)

**Note:** Version bump only for package @soat/cli

## [0.13.12](https://github.com/ttoss/soat/compare/v0.13.11...v0.13.12) (2026-07-02)

**Note:** Version bump only for package @soat/cli

## [0.13.11](https://github.com/ttoss/soat/compare/v0.13.10...v0.13.11) (2026-07-02)

**Note:** Version bump only for package @soat/cli

## [0.13.10](https://github.com/ttoss/soat/compare/v0.13.9...v0.13.10) (2026-07-01)

**Note:** Version bump only for package @soat/cli

## [0.13.9](https://github.com/ttoss/soat/compare/v0.13.8...v0.13.9) (2026-06-29)

**Note:** Version bump only for package @soat/cli

## [0.13.8](https://github.com/ttoss/soat/compare/v0.13.7...v0.13.8) (2026-06-28)

**Note:** Version bump only for package @soat/cli

## [0.13.7](https://github.com/ttoss/soat/compare/v0.13.6...v0.13.7) (2026-06-27)

**Note:** Version bump only for package @soat/cli

## [0.13.7](https://github.com/ttoss/soat/compare/v0.13.6...v0.13.7) (2026-06-27)

**Note:** Version bump only for package @soat/cli

## [0.13.6](https://github.com/ttoss/soat/compare/v0.13.5...v0.13.6) (2026-06-25)

**Note:** Version bump only for package @soat/cli

## [0.13.5](https://github.com/ttoss/soat/compare/v0.13.4...v0.13.5) (2026-06-25)

### Features

* **server:** make projectId implicit for project-scoped API keys ([#270](https://github.com/ttoss/soat/issues/270)) ([026edb7](https://github.com/ttoss/soat/commit/026edb7446f3cb176ef33a2087facd719d9f5095)), closes [#267](https://github.com/ttoss/soat/issues/267) [#267](https://github.com/ttoss/soat/issues/267)

## [0.13.4](https://github.com/ttoss/soat/compare/v0.13.3...v0.13.4) (2026-06-25)

### Features

* tighten weak/inconsistent REST field names ([#263](https://github.com/ttoss/soat/issues/263)) ([e5a3e84](https://github.com/ttoss/soat/commit/e5a3e84a))

### BREAKING CHANGES

* `create-memory-entry` now takes `--source-type` instead of `--source`, and `search-knowledge` results expose `similarity_score` instead of `score`. The generated route manifest is updated accordingly ([#263](https://github.com/ttoss/soat/issues/263)).

## [0.13.3](https://github.com/ttoss/soat/compare/v0.13.2...v0.13.3) (2026-06-24)

**Note:** Version bump only for package @soat/cli

## [0.13.2](https://github.com/ttoss/soat/compare/v0.13.1...v0.13.2) (2026-06-24)

**Note:** Version bump only for package @soat/cli

## [0.13.1](https://github.com/ttoss/soat/compare/v0.13.0...v0.13.1) (2026-06-23)

**Note:** Version bump only for package @soat/cli

# [0.13.0](https://github.com/ttoss/soat/compare/v0.12.5...v0.13.0) (2026-06-23)

* refactor(api)!: redesign REST surface to eliminate duplicate paths & MCP tools (D1–D11) (#237) ([3821c1d](https://github.com/ttoss/soat/commit/3821c1de45b7e1b6d401b44bd646a285701f58ca)), closes [#237](https://github.com/ttoss/soat/issues/237)

### BREAKING CHANGES

* the nested actor endpoints are removed; use /actors with the
agent_id/chat_id/conversation_id fields and filters instead.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: flatten agent sessions to top-level /sessions (D2/D8/D10)

Sessions become a top-level resource keyed by their globally-unique id:

- /agents/{agent_id}/sessions[/{session_id}][/...]  →  /sessions[/{session_id}][/...]
- create takes agent_id in the body; list filters with ?agent_id=
- session sub-routes (messages, generate, tool-outputs, tags) move under
  /sessions/{session_id}/...
- drop GET /sessions/{session_id}/messages (listAgentSessionMessages): it was a
  pure projection of the conversation's messages — read history via the session's
  conversation_id and GET /conversations/{id}/messages (D8/D10)

Route access control now resolves the session → agent + project (findSessionAccess)
instead of reading agent_id from the path; lib signatures are unchanged so the
sessions formation module (which self-resolves the agent id) needs no change.
operationIds renamed (createAgentSession→createSession, etc.); permission actions
kept as agents:* (policy-action renaming is out of scope for a path redesign).

Updates spec, routes, lib, permissions manifest, sessions module doc, and REST +
MCP + fk-on-delete tests. Tutorials are updated in a later batched pass (validated
via the Docker tutorial CI).
* agent session endpoints move from /agents/{agent_id}/sessions to
/sessions; the session message-list endpoint is removed (use the conversation).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: flatten orchestration runs to top-level /orchestration-runs (D2)

- /orchestrations/{id}/runs[/{run_id}][/...]  →  /orchestration-runs[/{run_id}][/...]
- start takes orchestration_id in the body; list filters with ?orchestration_id=
- get/cancel/resume/human-input key off the globally-unique run_id alone

The run-action lib functions already accepted orchestrationPublicId as optional,
so only listOrchestrationRuns needed it relaxed to an optional filter (lists all
accessible runs when absent). Routes, OpenAPI spec, orchestrations module doc,
REST tests, and smoke tests updated; SDK/CLI regenerated.
* orchestration run endpoints move from
/orchestrations/{id}/runs to /orchestration-runs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: flatten memory entries to top-level /memory-entries (D2)

- /memories/{memory_id}/entries[/{entry_id}]  →  /memory-entries[/{entry_id}]
- create takes memory_id in the body; list requires ?memory_id= (entries have no
  independent project scope, so the owning memory is required for access control)
- get/update/delete key off the globally-unique entry_id; access is resolved via
  the entry's owning memory's project

Lib signatures unchanged, so the memory-entries formation module and its
formations.yaml schema (already memory_id-based) need no change. Router moves
from under memoriesRouter to top-level. Routes, spec, memories module doc, and
REST tests (memories/knowledge/memoryExtraction/fkOnDelete) updated; smoke test
needs no change (--memory-id flag maps to body/query automatically). SDK/CLI
regenerated.
* memory entry endpoints move from /memories/{id}/entries to
/memory-entries.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: flatten webhook deliveries to top-level /webhook-deliveries (D2)

- /webhooks/{webhook_id}/deliveries[/{delivery_id}]  →  /webhook-deliveries[/{delivery_id}]
- list requires ?webhook_id= (deliveries have no independent project scope)
- get keys off the globally-unique delivery_id; access resolved via the
  delivery's owning webhook's project

The delivery responses now include webhook_id (added to the lib mappers, the
Delivery schema, and the module data model) so a delivery is self-describing as a
top-level resource. Routes stay in webhooksRouter (already top-level). Spec,
module doc, and REST tests updated; smoke needs no change (--webhook-id maps to
the query flag). SDK/CLI regenerated.
* webhook delivery endpoints move from /webhooks/{id}/deliveries
to /webhook-deliveries.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* docs: update api-redesign progress log (D2 flatten slices done)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: list generations top-level, drop /traces/{id}/generations (D3)

- add GET /api/v1/generations (listGenerations) with agent_id/trace_id/status
  filters — wires up the previously-unused listGenerations lib and adds a
  trace_id filter; new permission action generations:ListGenerations
- remove GET /traces/{trace_id}/generations (getTraceGenerations) + its lib
  function, TraceGenerations schema, and traces:GetTraceGenerations permission

The replacement returns full paginated generation records (not just IDs), and an
unknown trace_id filter yields an empty page rather than 404. Routes, specs,
permissions, traces/generations module docs, REST tests, and smoke updated;
SDK/CLI regenerated.
* GET /traces/{trace_id}/generations is removed; use
GET /generations?trace_id= instead (now returns full records, not ID lists).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: list user policies via /policies?user_id=, drop nested read (D3/D4/D11)

- add user_id filter to listPolicies; GET /policies?user_id= returns the policies
  attached to a user (unknown user → empty list)
- remove GET /users/{user_id}/policies (getUserPolicies) + its lib function and
  the users:GetUserPolicies permission
- keep PUT /users/{user_id}/policies (attachUserPolicies) — the relationship
  WRITE stays a dedicated, privileged verb per D4/D11 (reads dedup to a filter,
  writes stay side-specific)

Routes, specs, permissions, policies module doc, and policies tests updated;
SDK/CLI regenerated (147 routes).
* GET /users/{user_id}/policies is removed; use
GET /policies?user_id= instead.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* refactor(api)!: relocate stateless completions to POST /chat/completions (D9)

The OpenAI-compatible stateless completions endpoint has nothing to do with the
chats resource, so it moves out from under it:

- POST /chats/completions  →  POST /chat/completions (createChatCompletion)
- POST /chats/{chat_id}/completions (chat-scoped) unchanged

The singular /chat/completions path mirrors OpenAI's, so an OpenAI SDK can target
it by base URL alone; it also removes the latent /chats/completions vs
/chats/{chat_id}/completions route ambiguity. operationId and permission action
are unchanged (so the CLI command create-chat-completion and smoke tests need no
change). Route, spec, chats module doc, and REST tests updated; SDK/CLI
regenerated.
* the stateless chat completions endpoint moves from
/chats/completions to /chat/completions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* docs: update api-redesign progress log (D1-D11 implementation complete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* test(cli)!: update orchestration-run command tests for flattened paths (D2)

The CLI package has its own route tests; update them for the /orchestration-runs
flattening — start/list hit the top-level collection, get/cancel/resume key off
--run-id only (the --orchestration-id path flag is gone).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* docs(tutorials)!: update tutorials & getting-started for the redesigned API

Fix all tutorial CLI/SDK/curl tabs (and getting-started) for the flattened
surface — the CI tutorial runner failed chat-with-llm and
debug-session-generation-trace-history on the removed/renamed session commands:

- create-agent-session → create-session (agent_id now a body field)
- add-session-message / generate-session-response: drop --agent-id
- list-agent-session-messages (removed) → list-conversation-messages via the
  session's conversation_id (captured at creation)
- get-trace-generations / GET /traces/{id}/generations → GET /generations?trace_id=
- session/run/entry/delivery/policy/chat-completions paths flattened in curl/SDK
  tabs across chat-with-llm, debug-session-generation-trace-history,
  connect-third-party-llms, orchestrate-a-sonnet, memories-agent

Generated reference docs (api/cli/mcp/sdk) are gitignored and rebuilt in CI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* fix(api): MDX-safe descriptions + smoke commands for redesigned routes

CI surfaced two real failures (server + CLI unit tests now pass):

1. Docusaurus build of /docs/mcp/tools failed with "ReferenceError: trace_id is
   not defined" — the generated MCP tools doc is MDX, and two operation
   descriptions I added contained literal {trace_id}/{user_id}, which MDX parses
   as JS expressions. Reworded to drop the braces.
2. Smoke tests hit removed/renamed CLI commands missed in earlier slices:
   get-user-policies → list-policies --user-id; create-agent-actor →
   create-actor --agent-id; list-conversation-actors → list-actors
   --conversation-id; create-agent-session → create-session; add-session-message
   no longer takes --agent_id.

Tutorials pass. Generated MCP/SDK/CLI docs are gitignored and rebuilt in CI from
the corrected specs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* fix(api): server test fallout from the redesign (CI-surfaced)

First CI run of the server suite (couldn't run locally — no babel-jest) surfaced
12 failures, all addressed:

- sessions: 4 tests read the removed GET /sessions/:id/messages (405). Add a
  listSessionMessages helper that resolves the session's conversation_id and
  reads GET /conversations/:id/messages.
- policies: drop the leftover GET /users/:userId/policies describe block (that
  endpoint was removed; per-user listing is covered by GET /policies?user_id=).
- generations & orchestration-runs list routes: return 403 (not an empty 200)
  when the caller has access to zero projects, matching the modules' existing
  read-permission behavior and the "403/404" test expectations.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* fix(test): session message reads need conversations:GetConversation (D8)

The 4 session tests that read message history go through
GET /conversations/:id/messages (the session message-list endpoint was removed,
D8). That endpoint is governed by conversations:GetConversation, which the
session test user lacked → 403. Grant it (and drop the now-dead
agents:ListSessionMessages action). Document the permission requirement on the
sessions module page.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* test(server): cover sessionTags not-found guard to restore coverage

All 1582 server tests pass; the build now fails only on a coverage threshold:
sessionTags.ts branch coverage fell to 60% (needs 65%). The session-tags routes
now resolve+404 the session (checkSessionAccess) before calling the lib, so the
lib's own "session not found" guard is no longer hit via REST. Add a direct lib
test exercising that guard for getSessionTags/updateSessionTags. The defensive
check is kept (guards against a delete race between access check and lib call).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## [0.12.5](https://github.com/ttoss/soat/compare/v0.12.4...v0.12.5) (2026-06-23)

**Note:** Version bump only for package @soat/cli

## [0.12.4](https://github.com/ttoss/soat/compare/v0.12.3...v0.12.4) (2026-06-22)

**Note:** Version bump only for package @soat/cli

## [0.12.3](https://github.com/ttoss/soat/compare/v0.12.2...v0.12.3) (2026-06-22)

**Note:** Version bump only for package @soat/cli

## [0.12.2](https://github.com/ttoss/soat/compare/v0.12.0...v0.12.2) (2026-06-21)

**Note:** Version bump only for package @soat/cli

## [0.12.1](https://github.com/ttoss/soat/compare/v0.12.0...v0.12.1) (2026-06-21)

**Note:** Version bump only for package @soat/cli

# [0.12.0](https://github.com/ttoss/soat/compare/v0.11.0...v0.12.0) (2026-06-21)

**Note:** Version bump only for package @soat/cli

# [0.11.0](https://github.com/ttoss/soat/compare/v0.9.1...v0.11.0) (2026-06-13)

**Note:** Version bump only for package @soat/cli

# [0.10.0](https://github.com/ttoss/soat/compare/v0.9.1...v0.10.0) (2026-06-13)

**Note:** Version bump only for package @soat/cli

## [0.9.1](https://github.com/ttoss/soat/compare/v0.9.0...v0.9.1) (2026-06-12)

**Note:** Version bump only for package @soat/cli

# [0.9.0](https://github.com/ttoss/soat/compare/v0.8.2...v0.9.0) (2026-06-11)

**Note:** Version bump only for package @soat/cli

## [0.8.2](https://github.com/ttoss/soat/compare/v0.8.1...v0.8.2) (2026-06-11)

**Note:** Version bump only for package @soat/cli

## [0.8.1](https://github.com/ttoss/soat/compare/v0.8.0...v0.8.1) (2026-06-10)

**Note:** Version bump only for package @soat/cli

# 0.8.0 (2026-06-10)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://github.com/ttoss/soat/issues/114)) ([906dd0c](https://github.com/ttoss/soat/commit/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))
* issue 124 ([#125](https://github.com/ttoss/soat/issues/125)) ([b56320b](https://github.com/ttoss/soat/commit/b56320beddd901748a68fe21eb022821279e1eff))

### Features

* **sessions:** add idempotency_key to addSessionMessage ([#144](https://github.com/ttoss/soat/issues/144)) ([b242655](https://github.com/ttoss/soat/commit/b242655848ca9f3356ee6aa63bc13b9473bf787b))

## 0.7.1 (2026-06-09)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://github.com/ttoss/soat/issues/114)) ([906dd0c](https://github.com/ttoss/soat/commit/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))

### Features

* agent tool output ([#121](https://github.com/ttoss/soat/issues/121)) ([8bd54eb](https://github.com/ttoss/soat/commit/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://github.com/ttoss/soat/issues/144)) ([b242655](https://github.com/ttoss/soat/commit/b242655848ca9f3356ee6aa63bc13b9473bf787b))

# 0.7.0 (2026-06-08)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://github.com/ttoss/soat/issues/114)) ([906dd0c](https://github.com/ttoss/soat/commit/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))

### Features

* agent tool output ([#121](https://github.com/ttoss/soat/issues/121)) ([8bd54eb](https://github.com/ttoss/soat/commit/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://github.com/ttoss/soat/issues/144)) ([b242655](https://github.com/ttoss/soat/commit/b242655848ca9f3356ee6aa63bc13b9473bf787b))

## [0.6.13](https://github.com/ttoss/soat/compare/v0.6.12...v0.6.13) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.12](https://github.com/ttoss/soat/compare/v0.6.10...v0.6.12) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.11](https://github.com/ttoss/soat/compare/v0.6.10...v0.6.11) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.10](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.10) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.9](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.9) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.9](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.9) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.8](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.8) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.8](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.8) (2026-06-08)

**Note:** Version bump only for package @soat/cli

## [0.6.7](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.7) (2026-06-07)

**Note:** Version bump only for package @soat/cli

## [0.6.7](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.7) (2026-06-07)

**Note:** Version bump only for package @soat/cli

## [0.6.7](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.7) (2026-06-07)

**Note:** Version bump only for package @soat/cli

## [0.6.7](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.7) (2026-06-07)

**Note:** Version bump only for package @soat/cli

## [0.6.7](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.7) (2026-06-07)

**Note:** Version bump only for package @soat/cli

## [0.6.7](https://github.com/ttoss/soat/compare/v0.6.6...v0.6.7) (2026-06-07)

**Note:** Version bump only for package @soat/cli

## [0.6.6](https://github.com/ttoss/soat/compare/v0.6.5...v0.6.6) (2026-06-05)

**Note:** Version bump only for package @soat/cli

## [0.6.5](https://github.com/ttoss/soat/compare/v0.6.4...v0.6.5) (2026-06-05)

### Features

* **sessions:** add idempotency_key to addSessionMessage ([#144](https://github.com/ttoss/soat/issues/144)) ([b242655](https://github.com/ttoss/soat/commit/b242655848ca9f3356ee6aa63bc13b9473bf787b))

## [0.6.4](https://github.com/ttoss/soat/compare/v0.6.3...v0.6.4) (2026-06-04)

**Note:** Version bump only for package @soat/cli

## [0.6.3](https://github.com/ttoss/soat/compare/v0.6.2...v0.6.3) (2026-06-04)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://github.com/ttoss/soat/issues/114)) ([906dd0c](https://github.com/ttoss/soat/commit/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))

## [0.6.2](https://github.com/ttoss/soat/compare/v0.6.1...v0.6.2) (2026-06-01)

### Features

* agent tool output ([#121](https://github.com/ttoss/soat/issues/121)) ([8bd54eb](https://github.com/ttoss/soat/commit/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))

## [0.6.1](https://github.com/ttoss/soat/compare/v0.6.0...v0.6.1) (2026-05-28)

**Note:** Version bump only for package @soat/cli

# [0.6.0](https://github.com/ttoss/soat/compare/v0.5.8...v0.6.0) (2026-05-26)

**Note:** Version bump only for package @soat/cli

## [0.5.8](https://github.com/ttoss/soat/compare/v0.5.7...v0.5.8) (2026-05-26)

### Bug Fixes

* normalize API error envelope (avoid nested error.error payload) ([#97](https://github.com/ttoss/soat/issues/97)) ([86f519b](https://github.com/ttoss/soat/commit/86f519bc6198a3db7567d91e4231014b4e2b33a7))

## [0.5.7](https://github.com/ttoss/soat/compare/v0.5.6...v0.5.7) (2026-05-25)

### Bug Fixes

* formations ([#94](https://github.com/ttoss/soat/issues/94)) ([c4cee1f](https://github.com/ttoss/soat/commit/c4cee1f2ece14fd21d559f1ef55d506e01f88ae6))

## [0.5.6](https://github.com/ttoss/soat/compare/v0.5.5...v0.5.6) (2026-05-18)

### Bug Fixes

* issue 89 ([#90](https://github.com/ttoss/soat/issues/90)) ([890c2ed](https://github.com/ttoss/soat/commit/890c2edc7b246e6f9f4f5faaffefe4a71b9fa585))

## [0.5.5](https://github.com/ttoss/soat/compare/v0.5.4...v0.5.5) (2026-05-17)

### Features

* cli wrappers ([#88](https://github.com/ttoss/soat/issues/88)) ([88befab](https://github.com/ttoss/soat/commit/88befab2ef24172f080dd896b4aa45af704ac817))

## [0.5.4](https://github.com/ttoss/soat/compare/v0.5.3...v0.5.4) (2026-05-17)

**Note:** Version bump only for package @soat/cli

## [0.5.3](https://github.com/ttoss/soat/compare/v0.5.2...v0.5.3) (2026-05-17)

**Note:** Version bump only for package @soat/cli

## [0.5.2](https://github.com/ttoss/soat/compare/v0.5.1...v0.5.2) (2026-05-15)

**Note:** Version bump only for package @soat/cli

## [0.5.1](https://github.com/ttoss/soat/compare/v0.5.0...v0.5.1) (2026-05-13)

**Note:** Version bump only for package @soat/cli

# [0.5.0](https://github.com/ttoss/soat/compare/v0.4.18...v0.5.0) (2026-05-13)

### Features

* trace tree ([#81](https://github.com/ttoss/soat/issues/81)) ([d5e1c69](https://github.com/ttoss/soat/commit/d5e1c698bab222d352ef62ab00f743b0ecf7d1c8))

## [0.4.18](https://github.com/ttoss/soat/compare/v0.4.17...v0.4.18) (2026-05-08)

### Bug Fixes

* traces on database ([#79](https://github.com/ttoss/soat/issues/79)) ([dc41474](https://github.com/ttoss/soat/commit/dc414747ad870b97ed769caddb5d0954e2a8aa3a))

## [0.4.17](https://github.com/ttoss/soat/compare/v0.4.16...v0.4.17) (2026-05-03)

**Note:** Version bump only for package @soat/cli

## [0.4.16](https://github.com/ttoss/soat/compare/v0.4.15...v0.4.16) (2026-05-03)

**Note:** Version bump only for package @soat/cli

## [0.4.15](https://github.com/ttoss/soat/compare/v0.4.14...v0.4.15) (2026-05-02)

### Bug Fixes

* typecheck ([eff537d](https://github.com/ttoss/soat/commit/eff537d2ab77f85da841750d661d531a35f80b24))

## [0.4.14](https://github.com/ttoss/soat/compare/v0.4.13...v0.4.14) (2026-05-02)

**Note:** Version bump only for package @soat/cli

## [0.4.13](https://github.com/ttoss/soat/compare/v0.4.12...v0.4.13) (2026-05-02)

**Note:** Version bump only for package @soat/cli

## [0.4.12](https://github.com/ttoss/soat/compare/v0.4.11...v0.4.12) (2026-05-02)

**Note:** Version bump only for package @soat/cli

## [0.4.11](https://github.com/ttoss/soat/compare/v0.4.10...v0.4.11) (2026-05-02)

**Note:** Version bump only for package @soat/cli

## [0.4.10](https://github.com/ttoss/soat/compare/v0.4.9...v0.4.10) (2026-05-02)

**Note:** Version bump only for package @soat/cli

## [0.4.9](https://github.com/ttoss/soat/compare/v0.4.8...v0.4.9) (2026-04-29)

**Note:** Version bump only for package @soat/cli

## [0.4.8](https://github.com/ttoss/soat/compare/v0.4.7...v0.4.8) (2026-04-29)

**Note:** Version bump only for package @soat/cli

## [0.4.7](https://github.com/ttoss/soat/compare/v0.4.6...v0.4.7) (2026-04-28)

**Note:** Version bump only for package @soat/cli

## [0.4.6](https://github.com/ttoss/soat/compare/v0.4.5...v0.4.6) (2026-04-28)

### Bug Fixes

* register `soat` command on global install ([#47](https://github.com/ttoss/soat/issues/47)) ([f6f5657](https://github.com/ttoss/soat/commit/f6f56575dd4340016524d88589b0e9a745f80e5c))

## [0.4.5](https://github.com/ttoss/soat/compare/v0.4.4...v0.4.5) (2026-04-28)

**Note:** Version bump only for package @soat/cli

## [0.4.4](https://github.com/ttoss/soat/compare/v0.4.3...v0.4.4) (2026-04-28)

### Bug Fixes

* permissions ([#44](https://github.com/ttoss/soat/issues/44)) ([03710c2](https://github.com/ttoss/soat/commit/03710c2e5520c64b14fda7febc7b710dad13192b))

## [0.4.3](https://github.com/ttoss/soat/compare/v0.4.2...v0.4.3) (2026-04-27)

### Bug Fixes

* tag workflow ([88a911e](https://github.com/ttoss/soat/commit/88a911ea06c0f4cc051ae92289954f64c5b9dd3f))

## [0.4.2](https://github.com/ttoss/soat/compare/v0.4.1...v0.4.2) (2026-04-27)

**Note:** Version bump only for package @soat/cli

# [0.4.0](https://github.com/ttoss/soat/compare/v0.3.4...v0.4.0) (2026-04-27)

### Features

* memory ([#43](https://github.com/ttoss/soat/issues/43)) ([b47ad63](https://github.com/ttoss/soat/commit/b47ad63ef8838e7a46831fb05d67ae619b2c3c29))

## [0.3.3](https://github.com/ttoss/soat/compare/v0.3.2...v0.3.3) (2026-04-23)

**Note:** Version bump only for package @soat/cli

## [0.3.2](https://github.com/ttoss/soat/compare/v0.3.1...v0.3.2) (2026-04-23)

### Bug Fixes

* update packages ([0980fac](https://github.com/ttoss/soat/commit/0980faccf4ae058664dc53ba3c0868aba62d2dae))

# [0.3.0](https://github.com/ttoss/soat/compare/v0.2.0...v0.3.0) (2026-04-23)

**Note:** Version bump only for package @soat/cli

# [0.2.0](https://github.com/ttoss/soat/compare/v0.1.1...v0.2.0) (2026-04-22)

**Note:** Version bump only for package @soat/cli

# [0.1.0](https://github.com/ttoss/soat/compare/v0.0.0-alpha.2...v0.1.0) (2026-04-20)

**Note:** Version bump only for package @soat/cli

# 0.0.0-alpha.2 (2026-01-06)

### Bug Fixes

* add version ([de8fab4](https://github.com/ttoss/soat/commit/de8fab4e0d51ba0e06e0b29f9b26ea8d147d92a6))
