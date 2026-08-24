# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.29.6](https://github.com/ttoss/soat/compare/v0.29.5...v0.29.6) (2026-08-24)

**Note:** Version bump only for package @soat/postgresdb

## [0.29.5](https://github.com/ttoss/soat/compare/v0.29.4...v0.29.5) (2026-08-24)

**Note:** Version bump only for package @soat/postgresdb

## [0.29.4](https://github.com/ttoss/soat/compare/v0.29.3...v0.29.4) (2026-08-24)

**Note:** Version bump only for package @soat/postgresdb

## [0.29.3](https://github.com/ttoss/soat/compare/v0.29.2...v0.29.3) (2026-08-24)

**Note:** Version bump only for package @soat/postgresdb

## [0.29.2](https://github.com/ttoss/soat/compare/v0.29.1...v0.29.2) (2026-08-23)

**Note:** Version bump only for package @soat/postgresdb

## [0.29.1](https://github.com/ttoss/soat/compare/v0.29.0...v0.29.1) (2026-08-23)

**Note:** Version bump only for package @soat/postgresdb

# [0.29.0](https://github.com/ttoss/soat/compare/v0.28.0...v0.29.0) (2026-08-23)

**Note:** Version bump only for package @soat/postgresdb

# [0.28.0](https://github.com/ttoss/soat/compare/v0.27.0...v0.28.0) (2026-08-21)

**Note:** Version bump only for package @soat/postgresdb

# [0.27.0](https://github.com/ttoss/soat/compare/v0.26.0...v0.27.0) (2026-08-20)

**Note:** Version bump only for package @soat/postgresdb

# [0.26.0](https://github.com/ttoss/soat/compare/v0.25.1...v0.26.0) (2026-08-19)

**Note:** Version bump only for package @soat/postgresdb

## [0.25.1](https://github.com/ttoss/soat/compare/v0.25.0...v0.25.1) (2026-08-17)

**Note:** Version bump only for package @soat/postgresdb

# [0.25.0](https://github.com/ttoss/soat/compare/v0.24.0...v0.25.0) (2026-08-17)

**Note:** Version bump only for package @soat/postgresdb

# [0.24.0](https://github.com/ttoss/soat/compare/v0.23.0...v0.24.0) (2026-08-16)

### Bug Fixes

* **formations:** a failed deploy explains itself on the response ([#1028](https://github.com/ttoss/soat/issues/1028)) ([#1031](https://github.com/ttoss/soat/issues/1031)) ([50e20a2](https://github.com/ttoss/soat/commit/50e20a2773d790f513068053f85fc131372f4f85))
* **traces:** keep every generation's steps when a trace_id is reused ([#1027](https://github.com/ttoss/soat/issues/1027)) ([523d9f9](https://github.com/ttoss/soat/commit/523d9f99654e4f25ed0bcd81ff1d8329fd6e2028)), closes [#1024](https://github.com/ttoss/soat/issues/1024) [#1024](https://github.com/ttoss/soat/issues/1024) [pre-#1024](https://github.com/pre-/issues/1024)

### Features

* **memories:** entry provenance and temporal invalidation schema (RC-1, RC-2) ([#1025](https://github.com/ttoss/soat/issues/1025)) ([561efeb](https://github.com/ttoss/soat/commit/561efeb53d68e600f942ffbbbc5522b871be2b0a))
* **sessions:** fork a session from any point in its history ([#1023](https://github.com/ttoss/soat/issues/1023)) ([#1035](https://github.com/ttoss/soat/issues/1035)) ([cf234bb](https://github.com/ttoss/soat/commit/cf234bb87628ea308a318c82d5ab1d9fc93e40f2))
* **webhooks:** durable delivery outbox, redelivery, and timestamped signature ([#1052](https://github.com/ttoss/soat/issues/1052)) ([c7ce377](https://github.com/ttoss/soat/commit/c7ce377fd11cc383a51677c3c9b56342d3208ef0)), closes [#1037](https://github.com/ttoss/soat/issues/1037)
* **workflows:** add a `tool` on_enter dispatch kind ([#1053](https://github.com/ttoss/soat/issues/1053)) ([42f943f](https://github.com/ttoss/soat/commit/42f943f2167ca8dc2157fbb2d50b02821fbaaef8)), closes [#792](https://github.com/ttoss/soat/issues/792) [#1039](https://github.com/ttoss/soat/issues/1039)

# [0.23.0](https://github.com/ttoss/soat/compare/v0.22.1...v0.23.0) (2026-08-14)

### Features

* **evaluations:** curate dataset items from completed generations ([#1012](https://github.com/ttoss/soat/issues/1012)) ([8faac15](https://github.com/ttoss/soat/commit/8faac1507fb50f6d7f8945e85c930c6277e2ae7e)), closes [#1003](https://github.com/ttoss/soat/issues/1003)

## [0.22.1](https://github.com/ttoss/soat/compare/v0.22.0...v0.22.1) (2026-08-13)

**Note:** Version bump only for package @soat/postgresdb

# [0.22.0](https://github.com/ttoss/soat/compare/v0.21.0...v0.22.0) (2026-08-13)

**Note:** Version bump only for package @soat/postgresdb

# [0.21.0](https://github.com/ttoss/soat/compare/v0.20.5...v0.21.0) (2026-08-13)

* feat(discussions)!: remove the discussions module (#973) ([c2d9b02](https://github.com/ttoss/soat/commit/c2d9b02c9c9b9476359340ccb7423f4374bf7db4)), closes [#973](https://github.com/ttoss/soat/issues/973)

### Features

* **agents:** gate canary promotion on a passing eval run (Phase 3) ([#968](https://github.com/ttoss/soat/issues/968)) ([30df86f](https://github.com/ttoss/soat/commit/30df86f97e9b030d9fee2cef71f2e530defb28ba))
* **evaluations:** datasets, evals, and synchronous scored runs (Phase 1) ([#964](https://github.com/ttoss/soat/issues/964)) ([0c25434](https://github.com/ttoss/soat/commit/0c25434b61464c1ad6b734a60f1b9f5d66fde6d3))
* **evaluations:** LLM judge, queued runs, baseline deltas, and lifecycle webhooks (Phase 2) ([#966](https://github.com/ttoss/soat/issues/966)) ([7b5c06b](https://github.com/ttoss/soat/commit/7b5c06b75ecf4555705f290435a54a946d9edee6))
* **evaluations:** scheduled eval runs and evaluation formation resources (Phase 3) ([#969](https://github.com/ttoss/soat/issues/969)) ([3a2a18e](https://github.com/ttoss/soat/commit/3a2a18e3cc8f5202ebf2c0958f8faa1f3819a620))

### BREAKING CHANGES

* the /api/v1/discussions endpoints, their MCP tools and
  SDK/CLI operations, the `discussion` formation resource type, and the
  `discussions:*` permissions are removed. The 409 AI_PROVIDER_HAS_DEPENDENTS
  meta no longer carries discussionCount, discussionIds, or
  discussionParticipantCount. search-knowledge no longer excludes documents
  under /discussions/ by default, so legacy transcripts in an existing
  install become ordinary, searchable project documents within their own
  project until deleted.

## [0.20.5](https://github.com/ttoss/soat/compare/v0.20.4...v0.20.5) (2026-08-12)

**Note:** Version bump only for package @soat/postgresdb

## [0.20.4](https://github.com/ttoss/soat/compare/v0.20.3...v0.20.4) (2026-08-12)

**Note:** Version bump only for package @soat/postgresdb

## [0.20.3](https://github.com/ttoss/soat/compare/v0.20.2...v0.20.3) (2026-08-11)

### Features

* **server:** add a per-tool context_keys allowlist ([#949](https://github.com/ttoss/soat/issues/949)) ([fdfc095](https://github.com/ttoss/soat/commit/fdfc0953170120bff6ac2594edb4f523b376d167))
* **server:** carry tool_context on orchestration runs ([#946](https://github.com/ttoss/soat/issues/946)) ([8a38e95](https://github.com/ttoss/soat/commit/8a38e95eec5bc8295cb14887e92f4f48dbfb4bc6)), closes [#945](https://github.com/ttoss/soat/issues/945)
* **server:** carry tool_context through task automation dispatches ([#951](https://github.com/ttoss/soat/issues/951)) ([3c4f6a9](https://github.com/ttoss/soat/commit/3c4f6a994116f90ee245ef80fcac0a6198f196e7)), closes [850/#851](https://github.com/ttoss/soat/issues/851) [#950](https://github.com/ttoss/soat/issues/950) [786/#887](https://github.com/ttoss/soat/issues/887)

## [0.20.2](https://github.com/ttoss/soat/compare/v0.20.1...v0.20.2) (2026-08-10)

**Note:** Version bump only for package @soat/postgresdb

## [0.20.1](https://github.com/ttoss/soat/compare/v0.20.0...v0.20.1) (2026-08-09)

### Bug Fixes

* **workflows:** bound the composed workflow↔dispatch cycle ([#899](https://github.com/ttoss/soat/issues/899)) ([ea73a54](https://github.com/ttoss/soat/commit/ea73a54cdc5a02acd822c34fb8b757bfcced29a2)), closes [#885](https://github.com/ttoss/soat/issues/885)

# [0.20.0](https://github.com/ttoss/soat/compare/v0.19.2...v0.20.0) (2026-08-08)

### Bug Fixes

* **orchestrations:** pin a run to the graph it started on ([#892](https://github.com/ttoss/soat/issues/892)) ([cecda04](https://github.com/ttoss/soat/commit/cecda049071c52b91f9994f5563dc8084a34d369)), closes [#880](https://github.com/ttoss/soat/issues/880) [#883](https://github.com/ttoss/soat/issues/883) [#877](https://github.com/ttoss/soat/issues/877) [#872](https://github.com/ttoss/soat/issues/872)
* **workflows:** pin a task to the state machine it entered on ([#895](https://github.com/ttoss/soat/issues/895)) ([aaffa42](https://github.com/ttoss/soat/commit/aaffa42c20b66bf1fd9a0eab10c86709d422204c)), closes [#883](https://github.com/ttoss/soat/issues/883) [#882](https://github.com/ttoss/soat/issues/882)

### Features

* **orchestrations:** give durable runs an identity and fail soat calls loudly ([#879](https://github.com/ttoss/soat/issues/879)) ([b6b39df](https://github.com/ttoss/soat/commit/b6b39df15b4aa14c8d861e6ff738ac4e87cfcd19))
* **server:** extract a shared resource-versioning engine ([#880](https://github.com/ttoss/soat/issues/880)) ([95f08ec](https://github.com/ttoss/soat/commit/95f08ec1f45668255bb9f377bd2ac955e21407b6)), closes [#872](https://github.com/ttoss/soat/issues/872) [#877](https://github.com/ttoss/soat/issues/877)

### BREAKING CHANGES

* **server:** the `GuardrailVersion` response no longer carries a top-level
  `document` field. The archived policy moved to `config.document`, alongside the
  new `id`, `label` and `created_by` fields, so guardrail versions share one shape
  with agent versions. Read `config.document` where you read `document` before.
  The `guardrail_versions.document` column is renamed to `config` and rewrapped;
  schema sync does not migrate existing rows.

## [0.19.2](https://github.com/ttoss/soat/compare/v0.19.1...v0.19.2) (2026-08-07)

**Note:** Version bump only for package @soat/postgresdb

## [0.19.1](https://github.com/ttoss/soat/compare/v0.19.0...v0.19.1) (2026-08-07)

**Note:** Version bump only for package @soat/postgresdb

# [0.19.0](https://github.com/ttoss/soat/compare/v0.18.6...v0.19.0) (2026-08-06)

### Bug Fixes

* **discussions:** type DiscussionRun attribution instead of a free-form bag ([#858](https://github.com/ttoss/soat/issues/858)) ([#862](https://github.com/ttoss/soat/issues/862)) ([6d6fdaf](https://github.com/ttoss/soat/commit/6d6fdafc6f3cd1ca5389e2f7983b733689227f99)), closes [#842](https://github.com/ttoss/soat/issues/842) [#807](https://github.com/ttoss/soat/issues/807) [#856](https://github.com/ttoss/soat/issues/856)

### Features

* **traces,projects,agents:** content retention sweep and zero-retention mode ([#864](https://github.com/ttoss/soat/issues/864)) ([a51fae9](https://github.com/ttoss/soat/commit/a51fae9c413f2fac2df0b14a7af4c38b2affb4ab)), closes [#837](https://github.com/ttoss/soat/issues/837) [#838](https://github.com/ttoss/soat/issues/838) [#839](https://github.com/ttoss/soat/issues/839) [#836](https://github.com/ttoss/soat/issues/836) [#837](https://github.com/ttoss/soat/issues/837) [#838](https://github.com/ttoss/soat/issues/838) [861/#863](https://github.com/ttoss/soat/issues/863)

### BREAKING CHANGES

* **discussions:** `DiscussionRunRecord.started_by` is replaced by
  `started_by_principal_type` / `started_by_principal_id`, and
  `initiator_generation_id` is removed. Readers of `started_by.userId`
  should read `started_by_principal_id` (note it is the API key's id when a
  key made the call). Breaking accepted per the #856 precedent — SOAT is in
  beta.

  The old `started_by` and `initiator_generation_id` columns are nullable
  and no longer mapped, so existing databases need no migration; drop them
  at leisure with
  `ALTER TABLE discussion_runs DROP COLUMN IF EXISTS started_by, DROP COLUMN IF EXISTS initiator_generation_id`.

## [0.18.6](https://github.com/ttoss/soat/compare/v0.18.5...v0.18.6) (2026-08-05)

* Close the free-form-bag epic structurally: chokepoint identity pin, explicit workflow wire mappers, server-owned task last_result (#853) (#856) ([c9b5266](https://github.com/ttoss/soat/commit/c9b526644a2252ab6c14f42f84359d15be726d82)), closes [#853](https://github.com/ttoss/soat/issues/853) [#856](https://github.com/ttoss/soat/issues/856) [#850](https://github.com/ttoss/soat/issues/850) [#851](https://github.com/ttoss/soat/issues/851) [729/#737](https://github.com/ttoss/soat/issues/737) [#852](https://github.com/ttoss/soat/issues/852) [#846](https://github.com/ttoss/soat/issues/846)
* refactor(generations)!: move server-owned state out of the metadata bag into columns (#842) ([3d866bd](https://github.com/ttoss/soat/commit/3d866bd2a52ce14aea6a6e2e12d02cde93e2e805)), closes [#842](https://github.com/ttoss/soat/issues/842) [#651](https://github.com/ttoss/soat/issues/651) [#690](https://github.com/ttoss/soat/issues/690) [#729](https://github.com/ttoss/soat/issues/729) [#737](https://github.com/ttoss/soat/issues/737)

### Bug Fixes

* **conversations:** move server-recorded tool-call chain out of caller-writable metadata ([#844](https://github.com/ttoss/soat/issues/844)) ([#849](https://github.com/ttoss/soat/issues/849)) ([2c6cd29](https://github.com/ttoss/soat/commit/2c6cd29cc63ffbe540d8fbc54f51872b2f589247)), closes [#842](https://github.com/ttoss/soat/issues/842)
* **documents:** promote server-owned ingestion state out of caller-writable metadata ([#845](https://github.com/ttoss/soat/issues/845)) ([#854](https://github.com/ttoss/soat/issues/854)) ([5907882](https://github.com/ttoss/soat/commit/590788273b03cd31d5b836dbcacfe3a7b1e1082f)), closes [#842](https://github.com/ttoss/soat/issues/842)

### Features

* **ai-providers:** add google vertex ai as an llm provider ([#832](https://github.com/ttoss/soat/issues/832)) ([155c2e7](https://github.com/ttoss/soat/commit/155c2e7d23fe32bfd6a7404abd3582b731e96595))
* **traces,generations:** content purge endpoints — delete content, preserve the skeleton ([#847](https://github.com/ttoss/soat/issues/847)) ([d5bfdfa](https://github.com/ttoss/soat/commit/d5bfdfa2f933a45e698df1fad43f5ba2bcc67cd4)), closes [#836](https://github.com/ttoss/soat/issues/836) [#842](https://github.com/ttoss/soat/issues/842)

### BREAKING CHANGES

* **documents:** `chunk_count`, `total_pages`, and `failure_reason` no
  longer appear inside a document's `metadata` field on any endpoint. Clients
  reading `document.metadata.chunk_count` (or `.total_pages`, `.failure_reason`)
  must read the equivalent fields from `GET /documents/:id/status`
  (`chunk_count`, `total_pages`, `error`) instead.
* guards and expressions referencing task.payload.last_result
  must be rewritten to task.last_result; the dispatch result no longer appears
  inside payload.
* server-owned generation state has moved from inside `metadata`
  to top-level snake_case fields on the generation. Clients reading
  `generation.metadata.action_id`, `.trigger_id`, `.extraction`, `.routing` or
  `.agent_version` must read `generation.action_id` etc. instead. `metadata` now
  returns only caller-supplied keys, and no key is reserved — a PATCH carrying
  `action_id` is accepted as an annotation instead of rejected with 400.

## [0.18.5](https://github.com/ttoss/soat/compare/v0.18.4...v0.18.5) (2026-08-05)

**Note:** Version bump only for package @soat/postgresdb

## [0.18.4](https://127.0.0.1/41729/git/ttoss/compare/v0.18.3...v0.18.4) (2026-08-01)

**Note:** Version bump only for package @soat/postgresdb

## [0.18.3](https://127.0.0.1/41729/git/ttoss/compare/v0.18.2...v0.18.3) (2026-08-01)

**Note:** Version bump only for package @soat/postgresdb

## [0.18.2](https://127.0.0.1/41729/git/ttoss/compare/v0.18.1...v0.18.2) (2026-08-01)

### Features

* **agents:** version snapshots and staged rollout (PRD Phases 1-2) ([#796](https://127.0.0.1/41729/git/ttoss/issues/796)) ([037d597](https://127.0.0.1/41729/git/ttoss/commits/037d597518ee2b8a43b5037578757b43749cde64))

## [0.18.1](https://127.0.0.1/41729/git/ttoss/compare/v0.18.0...v0.18.1) (2026-07-31)

**Note:** Version bump only for package @soat/postgresdb

# [0.18.0](https://127.0.0.1/41729/git/ttoss/compare/v0.17.5...v0.18.0) (2026-07-30)

### Bug Fixes

* **postgresdb:** stop the mechanisms that produce bad indexes ([#780](https://127.0.0.1/41729/git/ttoss/issues/780)) ([f696c89](https://127.0.0.1/41729/git/ttoss/commits/f696c8917ea6f32aa98cf23e0b45d6a9a734151a)), closes [#508](https://127.0.0.1/41729/git/ttoss/issues/508) [#561](https://127.0.0.1/41729/git/ttoss/issues/561) [#561](https://127.0.0.1/41729/git/ttoss/issues/561) [#710](https://127.0.0.1/41729/git/ttoss/issues/710)

### Features

* **model-routes:** ordered provider failover for completions (model-routing PRD phases 1–2) ([#782](https://127.0.0.1/41729/git/ttoss/issues/782)) ([70cb5b3](https://127.0.0.1/41729/git/ttoss/commits/70cb5b3c33d6cb3d0d469a99856fd4c56f5dccfe))
* **model-routes:** project default route and remaining consumers (model-routing PRD phase 3) ([#785](https://127.0.0.1/41729/git/ttoss/issues/785)) ([db003bd](https://127.0.0.1/41729/git/ttoss/commits/db003bd888b7f143c85dd8e404f5eeb2423d9ef0))
* **workflows:** rename TaskTransition actor_* to principal_* ([#787](https://127.0.0.1/41729/git/ttoss/issues/787)) ([e6457da](https://127.0.0.1/41729/git/ttoss/commits/e6457da849314992a17a49ec18f628c548aa3d75))

### BREAKING CHANGES

* **workflows:** `GET /tasks/{id}/history` returns `principal_kind` /
  `principal_id` instead of `actor_kind` / `actor_id`, on REST, the SDK's
  `TaskTransition` interface, the CLI's `get-task-history` output and the MCP
  tool result. Workflow transition guards must read `principal` instead of
  `actor`. For `automation` moves `principal_id` is now always null — read
  `generation_id` / `orchestration_run_id` for the cause.

  Schema follow-up: this repo syncs with `sync --alter`, which adds the new
  columns but never drops the old ones. In each long-lived environment run
  `UPDATE task_transitions SET principal_kind = actor_kind, principal_id =
  actor_id;` (then null out principal_id where principal_kind = 'automation')
  before dropping `actor_kind` / `actor_id`.

## [0.17.5](https://127.0.0.1/41729/git/ttoss/compare/v0.17.4...v0.17.5) (2026-07-30)

**Note:** Version bump only for package @soat/postgresdb

## [0.17.4](https://127.0.0.1/41729/git/ttoss/compare/v0.17.3...v0.17.4) (2026-07-29)

**Note:** Version bump only for package @soat/postgresdb

## [0.17.3](https://127.0.0.1/41729/git/ttoss/compare/v0.17.1...v0.17.3) (2026-07-28)

* refactor!: rename orchestration run_id to orchestration_run_id (#763) ([74b5171](https://127.0.0.1/41729/git/ttoss/commits/74b51711c725af1a959feb13d985924b56622cd2)), closes [#763](https://127.0.0.1/41729/git/ttoss/issues/763)

### BREAKING CHANGES

* run_id query/path params and response fields are
  renamed to orchestration_run_id across usage, exceptions, approvals,
  activity, tasks, and orchestration-runs endpoints. Discussion-run
  endpoints are unaffected.

  * fix(cli): update orchestrations.test.ts for --orchestration-run-id flag rename

  Missed by the run_id -> orchestration_run_id rename since it lives
  under packages/cli/tests, not packages/server/tests. CI caught it:
  the old --run-id flag no longer exists on the regenerated CLI, so
  these tests failed with a missing-required-param exit.

  * docs: fix remaining --run-id CLI examples missed by the orchestration_run_id rename

  The run_id rename covered code, OpenAPI specs, and most docs, but
  several tutorial/module doc CLI examples calling
  get-orchestration-run, submit-human-input, and get-usage-receipt
  still showed the old --run-id flag. CI's tutorials-test job caught
  one (create-an-agent-squad); a full repo sweep found the rest
  (orchestration-control-flow, gate-a-tool-with-guardrails,
  approval-gate, orchestrate-a-sonnet, usage.md). Discussion-run
  --run-id usage (get-discussion-run) is untouched, correctly.

## [0.17.2](https://127.0.0.1/41729/git/ttoss/compare/v0.17.1...v0.17.2) (2026-07-28)

* refactor!: rename orchestration run_id to orchestration_run_id (#763) ([74b5171](https://127.0.0.1/41729/git/ttoss/commits/74b51711c725af1a959feb13d985924b56622cd2)), closes [#763](https://127.0.0.1/41729/git/ttoss/issues/763)

### BREAKING CHANGES

* run_id query/path params and response fields are
  renamed to orchestration_run_id across usage, exceptions, approvals,
  activity, tasks, and orchestration-runs endpoints. Discussion-run
  endpoints are unaffected.

  * fix(cli): update orchestrations.test.ts for --orchestration-run-id flag rename

  Missed by the run_id -> orchestration_run_id rename since it lives
  under packages/cli/tests, not packages/server/tests. CI caught it:
  the old --run-id flag no longer exists on the regenerated CLI, so
  these tests failed with a missing-required-param exit.

  * docs: fix remaining --run-id CLI examples missed by the orchestration_run_id rename

  The run_id rename covered code, OpenAPI specs, and most docs, but
  several tutorial/module doc CLI examples calling
  get-orchestration-run, submit-human-input, and get-usage-receipt
  still showed the old --run-id flag. CI's tutorials-test job caught
  one (create-an-agent-squad); a full repo sweep found the rest
  (orchestration-control-flow, gate-a-tool-with-guardrails,
  approval-gate, orchestrate-a-sonnet, usage.md). Discussion-run
  --run-id usage (get-discussion-run) is untouched, correctly.

## [0.17.1](https://127.0.0.1/41729/git/ttoss/compare/v0.17.0...v0.17.1) (2026-07-28)

### Features

* **activity:** ship the G3 Phase 4 activity feed ([#755](https://127.0.0.1/41729/git/ttoss/issues/755)) ([35f2c4c](https://127.0.0.1/41729/git/ttoss/commits/35f2c4c8742d0a3fad86771f80dee5a4ddb74d20))

# [0.17.0](https://127.0.0.1/41729/git/ttoss/compare/v0.16.3...v0.17.0) (2026-07-27)

**Note:** Version bump only for package @soat/postgresdb

## [0.16.3](https://127.0.0.1/41729/git/ttoss/compare/v0.16.2...v0.16.3) (2026-07-26)

**Note:** Version bump only for package @soat/postgresdb

## [0.16.2](https://127.0.0.1/41729/git/ttoss/compare/v0.16.1...v0.16.2) (2026-07-26)

### Bug Fixes

* **postgresdb:** declare unique constraints as named indexes ([#710](https://127.0.0.1/41729/git/ttoss/issues/710)) ([7a7c405](https://127.0.0.1/41729/git/ttoss/commits/7a7c40595fbe33f5aa7307a438d89a15047fabc2))

### Features

* **quotas:** add actor scope for per-end-user token and cost caps ([#702](https://127.0.0.1/41729/git/ttoss/issues/702)) ([2c41429](https://127.0.0.1/41729/git/ttoss/commits/2c4142998d1ace53b04043a4851b997fc133afdf)), closes [#699](https://127.0.0.1/41729/git/ttoss/issues/699)
* **usage:** attribute usage events to the end-user actor and session ([#699](https://127.0.0.1/41729/git/ttoss/issues/699)) ([06636cc](https://127.0.0.1/41729/git/ttoss/commits/06636cc3f90facb7cb85b43eba98a15386493cee)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482) [#484](https://127.0.0.1/41729/git/ttoss/issues/484)

## [0.16.1](https://127.0.0.1/41729/git/ttoss/compare/v0.16.0...v0.16.1) (2026-07-25)

### Bug Fixes

* **quotas:** re-arm the breach fire guard on limit change, and surface unenforceable cost caps ([#696](https://127.0.0.1/41729/git/ttoss/issues/696)) ([b4d3886](https://127.0.0.1/41729/git/ttoss/commits/b4d3886b624314bbd2dc6598f0428ce88b790390)), closes [#692](https://127.0.0.1/41729/git/ttoss/issues/692) [#694](https://127.0.0.1/41729/git/ttoss/issues/694)

# [0.16.0](https://127.0.0.1/41729/git/ttoss/compare/v0.15.14...v0.16.0) (2026-07-25)

### Features

* **audit-log:** read-auditing flag, audit.entry_created webhook, NDJSON export (P3) ([#685](https://127.0.0.1/41729/git/ttoss/issues/685)) ([2a105ce](https://127.0.0.1/41729/git/ttoss/commits/2a105ce1482c06f9f863701f774129f1388640df))
* **quotas:** persist monitor-mode breach as a system audit entry ([#679](https://127.0.0.1/41729/git/ttoss/issues/679)) ([47ce5bf](https://127.0.0.1/41729/git/ttoss/commits/47ce5bfc01f90570b7a494760d850663943fd190))

## [0.15.14](https://127.0.0.1/41729/git/ttoss/compare/v0.15.13...v0.15.14) (2026-07-24)

* feat(approvals)!: remove knowledge packages (G7); defer learned rules (G6) into an approvals recurrence view (#672) ([9ae83d9](https://127.0.0.1/41729/git/ttoss/commits/9ae83d94f041c2eb1c4fd078b3b03b9dfc0013f0)), closes [#672](https://127.0.0.1/41729/git/ttoss/issues/672)

### Features

* **approvals:** thread previous_item_id on re-proposals after rejection ([#671](https://127.0.0.1/41729/git/ttoss/issues/671)) ([59ed4dc](https://127.0.0.1/41729/git/ttoss/commits/59ed4dc8b1d2f6c1f1f4da253af379eac9d421b2))

### BREAKING CHANGES

* the `knowledge_version` field is removed from the
  approval item shape (REST/MCP/SDK) and the ApprovalItem model.
  `policy_version` (guardrail-tied) is unchanged.

  - ApprovalItem: drop knowledgeVersion column; approvals.ts mapper /
    EmitApprovalArgs / insert; approvals.yaml schema property
  - generations: neutralize knowledge_version/playbook metadata examples
    (spec, module doc, tests, smoke-tests) — they only demoed free-form
    caller metadata
  - docs: delete prd-knowledge-packages.md; strip G7 from roadmap,
    prd-agent-operations, prd-approvals; reframe G6 learned-rules as an
    app-injected read surface; add a "Boundary: context composition"
    decision record to the roadmap

## [0.15.13](https://127.0.0.1/41729/git/ttoss/compare/v0.15.12...v0.15.13) (2026-07-23)

**Note:** Version bump only for package @soat/postgresdb

## [0.15.12](https://127.0.0.1/41729/git/ttoss/compare/v0.15.11...v0.15.12) (2026-07-22)

### Features

* **audit-log:** Phase 1 — request id, append-only table, write hook, read API, retention ([#641](https://127.0.0.1/41729/git/ttoss/issues/641)) ([4a16724](https://127.0.0.1/41729/git/ttoss/commits/4a16724f8be66998d618760eea484882d2eb3746))
* **exceptions:** G3 Phase 3 — first-class exception queue ([#648](https://127.0.0.1/41729/git/ttoss/issues/648)) ([5b5871c](https://127.0.0.1/41729/git/ttoss/commits/5b5871c38dabf8b15dba9199df6b1164a20cbc58))
* **orchestrations:** concurrency limits (per project + global) ([#642](https://127.0.0.1/41729/git/ttoss/issues/642)) ([e8c0b88](https://127.0.0.1/41729/git/ttoss/commits/e8c0b88425c6f1b9401fa18dc0293c7b120bf23a))
* **orchestrations:** queue-backed durable execution + idempotency keys (P1) ([#628](https://127.0.0.1/41729/git/ttoss/issues/628)) ([4b265ea](https://127.0.0.1/41729/git/ttoss/commits/4b265ea9da9df39c309e0130428fddff4bceff5e))
* **quotas:** Phase 1 — requests quotas, CRUD, and 429 middleware ([#631](https://127.0.0.1/41729/git/ttoss/issues/631)) ([6c66445](https://127.0.0.1/41729/git/ttoss/commits/6c664457bd3d49bbb7407f70738370fd0c0e0856))

## [0.15.11](https://127.0.0.1/41729/git/ttoss/compare/v0.15.10...v0.15.11) (2026-07-20)

### Features

* **guardrails:** action-class evaluation engine + guardrail_ids attach layer (task 2.2) ([#620](https://127.0.0.1/41729/git/ttoss/issues/620)) ([13d50e2](https://127.0.0.1/41729/git/ttoss/commits/13d50e20f3cf19651fb796eb773fda2720996648))
* **guardrails:** action-class guardrails — M2 contract + resource (task 2.1) ([#582](https://127.0.0.1/41729/git/ttoss/issues/582)) ([6e7b99b](https://127.0.0.1/41729/git/ttoss/commits/6e7b99b1847f0bf6739445bb20505fbac6894831))
* **guardrails:** remove per-binding approval_policy (task 2.8, breaking) ([#623](https://127.0.0.1/41729/git/ttoss/issues/623)) ([8a3152e](https://127.0.0.1/41729/git/ttoss/commits/8a3152ea6e6de05aceb4ac8b8a96c0ea3faa893c))
* **guardrails:** wire the evaluation engine into tool-dispatch + audit record + dry-run (tasks 2.3/2.6/2.9) ([#621](https://127.0.0.1/41729/git/ttoss/issues/621)) ([aafabcb](https://127.0.0.1/41729/git/ttoss/commits/aafabcbb522da5666bf6f25c37f140609fafb654)), closes [#620](https://127.0.0.1/41729/git/ttoss/issues/620)

### BREAKING CHANGES

* **guardrails:** the per-binding `approval_policy` on agent tool_bindings
  has been removed. Attach a guardrail instead (a `{ "class": "C" }`
  guardrail on the tool reproduces a `require_approval` binding).
  Guardrails are the sole tool-call gating mechanism.

## [0.15.10](https://127.0.0.1/41729/git/ttoss/compare/v0.15.9...v0.15.10) (2026-07-19)

### Bug Fixes

* **workflows,tasks,users,mcp,cli:** resolve issues [#604](https://127.0.0.1/41729/git/ttoss/issues/604)–[#611](https://127.0.0.1/41729/git/ttoss/issues/611) ([#613](https://127.0.0.1/41729/git/ttoss/issues/613)) ([ab951df](https://127.0.0.1/41729/git/ttoss/commits/ab951df309525cf2e266d82e667b7418e5fc02a3)), closes [#605](https://127.0.0.1/41729/git/ttoss/issues/605) [#606](https://127.0.0.1/41729/git/ttoss/issues/606) [#607](https://127.0.0.1/41729/git/ttoss/issues/607) [#608](https://127.0.0.1/41729/git/ttoss/issues/608) [#609](https://127.0.0.1/41729/git/ttoss/issues/609) [#610](https://127.0.0.1/41729/git/ttoss/issues/610)

### Features

* **workflows:** Phase 3 — approval-gated transitions and stall/SLA sweeper ([#612](https://127.0.0.1/41729/git/ttoss/issues/612)) ([2265e3b](https://127.0.0.1/41729/git/ttoss/commits/2265e3bfc87bde66bb85d03a3189ce6f4d2e77cf)), closes [#591](https://127.0.0.1/41729/git/ttoss/issues/591)

## [0.15.9](https://127.0.0.1/41729/git/ttoss/compare/v0.15.8...v0.15.9) (2026-07-18)

**Note:** Version bump only for package @soat/postgresdb

## [0.15.8](https://127.0.0.1/41729/git/ttoss/compare/v0.15.7...v0.15.8) (2026-07-18)

### Features

* **workflows,tasks:** stateful work-item module (workflows PRD, Phases 1–2) ([#583](https://127.0.0.1/41729/git/ttoss/issues/583)) ([4582786](https://127.0.0.1/41729/git/ttoss/commits/45827865bf3a5141c4401ddc638585ccfe37518a))

## [0.15.7](https://127.0.0.1/41729/git/ttoss/compare/v0.15.6...v0.15.7) (2026-07-18)

### Features

* **agents,approvals:** tool-call approval interception on every surface (Milestone 1) ([#581](https://127.0.0.1/41729/git/ttoss/issues/581)) ([da69b2e](https://127.0.0.1/41729/git/ttoss/commits/da69b2e0271e441b9bd4b3d13f7fa0f7ffe1c4c9)), closes [#2](https://127.0.0.1/41729/git/ttoss/issues/2)
* **api-keys:** support unscoped API keys (optional project_id) ([#584](https://127.0.0.1/41729/git/ttoss/issues/584)) ([00360c2](https://127.0.0.1/41729/git/ttoss/commits/00360c2725e35e2c4b00a0f2f965c04bdc234a05))

## [0.15.6](https://127.0.0.1/41729/git/ttoss/compare/v0.15.5...v0.15.6) (2026-07-17)

### Bug Fixes

* **formations:** resolve sub/param/ref in top-level template metadata ([#578](https://127.0.0.1/41729/git/ttoss/issues/578)) ([842e496](https://127.0.0.1/41729/git/ttoss/commits/842e496e257159d9ae84051a8c33f3b761f0581e))

## [0.15.5](https://127.0.0.1/41729/git/ttoss/compare/v0.15.4...v0.15.5) (2026-07-17)

### Bug Fixes

* **formations:** persist document chunk config so plans converge (F-13) ([#570](https://127.0.0.1/41729/git/ttoss/issues/570)) ([9549e21](https://127.0.0.1/41729/git/ttoss/commits/9549e2113b84042f31284ea1f3b6d4df41018502))

### Features

* **memories:** per-entry tags/metadata and entry-granularity tag filtering ([#571](https://127.0.0.1/41729/git/ttoss/issues/571)) ([0955ebc](https://127.0.0.1/41729/git/ttoss/commits/0955ebc819175d9002baa8fb4d456f0463f8eae5))

## [0.15.4](https://127.0.0.1/41729/git/ttoss/compare/v0.15.3...v0.15.4) (2026-07-16)

### Features

* **usage:** per-run cost — run/node attribution, run receipt, run roll-up (Milestone 1) ([#562](https://127.0.0.1/41729/git/ttoss/issues/562)) ([7273bfb](https://127.0.0.1/41729/git/ttoss/commits/7273bfbbcb0bb65f638f4eaf2d916f502a58fdeb))
* **usage:** usage thresholds + threshold-crossed webhook (Milestone 3.2/3.3) ([#565](https://127.0.0.1/41729/git/ttoss/issues/565)) ([d04d3d8](https://127.0.0.1/41729/git/ttoss/commits/d04d3d8ed24980316e250dcae9f83585580cf0e9))

## [0.15.3](https://127.0.0.1/41729/git/ttoss/compare/v0.15.2...v0.15.3) (2026-07-16)

### Bug Fixes

* **server:** bound boot schema-sync advisory-lock wait ([#549](https://127.0.0.1/41729/git/ttoss/issues/549)) ([978a27c](https://127.0.0.1/41729/git/ttoss/commits/978a27c5f6f04a42016089a9c04998ee898e8217))

## [0.15.2](https://127.0.0.1/41729/git/ttoss/compare/v0.15.1...v0.15.2) (2026-07-15)

### Features

* **server:** serialize boot-time schema sync with a Postgres advisory lock ([#544](https://127.0.0.1/41729/git/ttoss/issues/544)) ([d59bba7](https://127.0.0.1/41729/git/ttoss/commits/d59bba73b9ef7327360201b05b5383fce7b01334))

## [0.15.1](https://127.0.0.1/41729/git/ttoss/compare/v0.15.0...v0.15.1) (2026-07-15)

**Note:** Version bump only for package @soat/postgresdb

# [0.15.0](https://127.0.0.1/41729/git/ttoss/compare/v0.14.12...v0.15.0) (2026-07-14)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.12](https://127.0.0.1/41729/git/ttoss/compare/v0.14.11...v0.14.12) (2026-07-14)

### Features

* **tools:** scope mcp tools with a denied_actions denylist ([#533](https://127.0.0.1/41729/git/ttoss/issues/533)) ([838bab1](https://127.0.0.1/41729/git/ttoss/commits/838bab1dee653aa32e72c8203e1290609f47e8ef)), closes [#521](https://127.0.0.1/41729/git/ttoss/issues/521)

## [0.14.11](https://127.0.0.1/41729/git/ttoss/compare/v0.14.10...v0.14.11) (2026-07-14)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.10](https://127.0.0.1/41729/git/ttoss/compare/v0.14.9...v0.14.10) (2026-07-12)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.9](https://github.com/ttoss/soat/compare/v0.14.8...v0.14.9) (2026-07-12)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.8](https://github.com/ttoss/soat/compare/v0.14.7...v0.14.8) (2026-07-11)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.7](https://github.com/ttoss/soat/compare/v0.14.6...v0.14.7) (2026-07-10)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.6](https://github.com/ttoss/soat/compare/v0.14.5...v0.14.6) (2026-07-10)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.5](https://127.0.0.1/41729/git/ttoss/compare/v0.14.4...v0.14.5) (2026-07-09)

### Bug Fixes

* price_books index name exceeds Postgres's 63-char limit, crashing every reboot ([#508](https://127.0.0.1/41729/git/ttoss/issues/508)) ([6aeb5e2](https://127.0.0.1/41729/git/ttoss/commits/6aeb5e29913220adb73612ebb4470f41a1c1b4fc))

## [0.14.4](https://127.0.0.1/41729/git/ttoss/compare/v0.14.3...v0.14.4) (2026-07-08)

### Features

* **pricing:** project + provider-slug price tier (3-tier pricing) ([#502](https://127.0.0.1/41729/git/ttoss/issues/502)) ([#504](https://127.0.0.1/41729/git/ttoss/issues/504)) ([b427abe](https://127.0.0.1/41729/git/ttoss/commits/b427abe1b84f7478dba510d0c4285970b66e7052))
* **usage:** per-generation billing receipt and price_id link ([#487](https://127.0.0.1/41729/git/ttoss/issues/487)) ([#496](https://127.0.0.1/41729/git/ttoss/issues/496)) ([55a4ee7](https://127.0.0.1/41729/git/ttoss/commits/55a4ee7ea89db7976b28b994ea55e3adaaa1ca21))

## [0.14.3](https://127.0.0.1/41729/git/ttoss/compare/v0.14.2...v0.14.3) (2026-07-08)

### Features

* **usage:** attribute usage meters to trace_id ([#484](https://127.0.0.1/41729/git/ttoss/issues/484)) ([#490](https://127.0.0.1/41729/git/ttoss/issues/490)) ([a46f70d](https://127.0.0.1/41729/git/ttoss/commits/a46f70dcdd2d5e2be2ac60e4769aa9b893b4509b)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482)
* **usage:** attribute usage meters to trigger and logical action id ([#485](https://127.0.0.1/41729/git/ttoss/issues/485)) ([#491](https://127.0.0.1/41729/git/ttoss/issues/491)) ([a00b0e5](https://127.0.0.1/41729/git/ttoss/commits/a00b0e593ef3ebff56823c28650157b7f63ca9a7)), closes [#486](https://127.0.0.1/41729/git/ttoss/issues/486) [#482](https://127.0.0.1/41729/git/ttoss/issues/482)
* **usage:** per-generation token metering with reasoning tokens ([#483](https://127.0.0.1/41729/git/ttoss/issues/483)) ([#489](https://127.0.0.1/41729/git/ttoss/issues/489)) ([5c397f5](https://127.0.0.1/41729/git/ttoss/commits/5c397f566d32358daee89462a41883343d842fa2)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482)
* **usage:** price book + write-time cost + default prices ([#488](https://127.0.0.1/41729/git/ttoss/issues/488)) ([#493](https://127.0.0.1/41729/git/ttoss/issues/493)) ([3063e64](https://127.0.0.1/41729/git/ttoss/commits/3063e640c454e1f02c5d1c7dd7a2f3307fb36f29)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482) [#483](https://127.0.0.1/41729/git/ttoss/issues/483) [#483](https://127.0.0.1/41729/git/ttoss/issues/483) [#484](https://127.0.0.1/41729/git/ttoss/issues/484) [#485](https://127.0.0.1/41729/git/ttoss/issues/485) [#486](https://127.0.0.1/41729/git/ttoss/issues/486) [#482](https://127.0.0.1/41729/git/ttoss/issues/482)

## [0.14.2](https://127.0.0.1/41729/git/ttoss/compare/v0.14.1...v0.14.2) (2026-07-08)

**Note:** Version bump only for package @soat/postgresdb

## [0.14.1](https://127.0.0.1/41729/git/ttoss/compare/v0.14.0...v0.14.1) (2026-07-07)

**Note:** Version bump only for package @soat/postgresdb

# [0.14.0](https://127.0.0.1/41729/git/ttoss/compare/v0.13.20...v0.14.0) (2026-07-05)

### Features

* **orchestrations:** crash recovery for in-flight runs (orphaned-run reaper) ([#415](https://127.0.0.1/41729/git/ttoss/issues/415)) ([c3148b3](https://127.0.0.1/41729/git/ttoss/commits/c3148b322c47c94cdd9e2bdada7ea1a0e6bb77d7)), closes [#407](https://127.0.0.1/41729/git/ttoss/issues/407) [#403](https://127.0.0.1/41729/git/ttoss/issues/403) [#404](https://127.0.0.1/41729/git/ttoss/issues/404) [#404](https://127.0.0.1/41729/git/ttoss/issues/404)
* **orchestrations:** per-node retry policy with backoff (R2.3) ([#416](https://127.0.0.1/41729/git/ttoss/issues/416)) ([22992a8](https://127.0.0.1/41729/git/ttoss/commits/22992a868c4ab3d0fbe10d11af20061c564fa6cd)), closes [#407](https://127.0.0.1/41729/git/ttoss/issues/407) [#403](https://127.0.0.1/41729/git/ttoss/issues/403) [#405](https://127.0.0.1/41729/git/ttoss/issues/405) [#405](https://127.0.0.1/41729/git/ttoss/issues/405)

## [0.13.20](https://127.0.0.1/41729/git/ttoss/compare/v0.13.19...v0.13.20) (2026-07-05)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.19](https://127.0.0.1/41729/git/ttoss/compare/v0.13.18...v0.13.19) (2026-07-04)

### Features

* **agents:** allow inline tool definitions alongside tool_ids ([#387](https://127.0.0.1/41729/git/ttoss/issues/387)) ([8fda25b](https://127.0.0.1/41729/git/ttoss/commits/8fda25b6aee9b51548bf81a331727d161446179f))
* **orchestrations:** durable background run execution ([#374](https://127.0.0.1/41729/git/ttoss/issues/374)) ([96a510d](https://127.0.0.1/41729/git/ttoss/commits/96a510ddb94674726237d62dac8f7c507eb01d11)), closes [#366](https://127.0.0.1/41729/git/ttoss/issues/366)

## [0.13.18](https://127.0.0.1/41729/git/ttoss/compare/v0.13.17...v0.13.18) (2026-07-03)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.17](https://127.0.0.1/41729/git/ttoss/compare/v0.13.16...v0.13.17) (2026-07-03)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.16](https://127.0.0.1/41729/git/ttoss/compare/v0.13.15...v0.13.16) (2026-07-03)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.15](https://127.0.0.1/41729/git/ttoss/compare/v0.13.14...v0.13.15) (2026-07-03)

### Features

* **tools:** add universal output_mapping field to reshape tool results ([#349](https://127.0.0.1/41729/git/ttoss/issues/349)) ([fb93b65](https://127.0.0.1/41729/git/ttoss/commits/fb93b65681fccdf11c22b76ab28ca1c65102101e)), closes [#346](https://127.0.0.1/41729/git/ttoss/issues/346)

## [0.13.14](https://127.0.0.1/41729/git/ttoss/compare/v0.13.13...v0.13.14) (2026-07-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.13](https://127.0.0.1/41729/git/ttoss/compare/v0.13.12...v0.13.13) (2026-07-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.12](https://127.0.0.1/41729/git/ttoss/compare/v0.13.11...v0.13.12) (2026-07-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.11](https://127.0.0.1/41729/git/ttoss/compare/v0.13.10...v0.13.11) (2026-07-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.10](https://127.0.0.1/41729/git/ttoss/compare/v0.13.9...v0.13.10) (2026-07-01)

### Features

* **agents:** add output_schema for structured output generation ([#309](https://127.0.0.1/41729/git/ttoss/issues/309)) ([15c4e53](https://127.0.0.1/41729/git/ttoss/commits/15c4e536fd90305198686bae7327b7812c1a91b5))

## [0.13.9](https://127.0.0.1/41729/git/ttoss/compare/v0.13.8...v0.13.9) (2026-06-29)

### Features

* **iam:** enforce OAuth consent and require single-project API keys ([#298](https://127.0.0.1/41729/git/ttoss/issues/298)) ([4a7090d](https://127.0.0.1/41729/git/ttoss/commits/4a7090d92606acdb1b96acc225bc73f266962669))

### BREAKING CHANGES

* **iam:** API keys now require `project_id`; global (all-project)
keys can no longer be created, and an existing key's project scope cannot
be cleared. OAuth access tokens now enforce the consented scope at
request time, so a token may have fewer effective permissions than
before (limited to what was consented, intersected with the user).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01163By7fL9BGukpxNd3duHY

* test(oauth): assert user-policy ceiling holds through an OAuth token

A non-admin with a read-only policy and an OAuth token consented to all
permissions (`*`) can still read but cannot delete a file — proving the
consented scope cannot escalate beyond the owning user's policies, the
same ceiling already verified for API keys.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01163By7fL9BGukpxNd3duHY

## [0.13.8](https://127.0.0.1/41729/git/ttoss/compare/v0.13.7...v0.13.8) (2026-06-28)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.7](https://127.0.0.1/41729/git/ttoss/compare/v0.13.6...v0.13.7) (2026-06-27)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.7](https://127.0.0.1/41729/git/ttoss/compare/v0.13.6...v0.13.7) (2026-06-27)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.6](https://127.0.0.1/41729/git/ttoss/compare/v0.13.5...v0.13.6) (2026-06-25)

**Note:** Version bump only for package @soat/postgresdb

## [0.13.5](https://127.0.0.1/41729/git/ttoss/compare/v0.13.4...v0.13.5) (2026-06-25)

### Features

* **files:** add upload token endpoint for large file uploads via MCP ([#269](https://127.0.0.1/41729/git/ttoss/issues/269)) ([e62627c](https://127.0.0.1/41729/git/ttoss/commits/e62627c2409a1d8049f80fdd21fbd02e3ccbe29e))

## [0.13.4](https://127.0.0.1/41729/git/ttoss/compare/v0.13.3...v0.13.4) (2026-06-25)

### Features

* add pipeline tool type for deterministic multi-step tool sequences ([#260](https://127.0.0.1/41729/git/ttoss/issues/260)) ([4a90872](https://127.0.0.1/41729/git/ttoss/commits/4a90872bcd7b073b663155c6a4be60e65d23cdbb))

## [0.13.3](https://127.0.0.1/41729/git/ttoss/compare/v0.13.2...v0.13.3) (2026-06-24)

### Features

* **documents:** async file ingestion with 202 + job status polling ([#250](https://127.0.0.1/41729/git/ttoss/issues/250)) ([9e07595](https://127.0.0.1/41729/git/ttoss/commits/9e075959068ddd277c5db892f3f4defb73a96979))
* **orchestrations:** record skipped node executions on completed runs ([#253](https://127.0.0.1/41729/git/ttoss/issues/253)) ([0a6f9b9](https://127.0.0.1/41729/git/ttoss/commits/0a6f9b9849fa73d90d89c850c01b7e424d7f796e))

## [0.13.2](https://127.0.0.1/41729/git/ttoss/compare/v0.13.1...v0.13.2) (2026-06-24)

### Features

* **documents:** native file ingestion with DocumentChunk model ([#245](https://127.0.0.1/41729/git/ttoss/issues/245)) ([5e9776c](https://127.0.0.1/41729/git/ttoss/commits/5e9776c9c01d456a360b6c5ae595098d87bfcb24))

## [0.13.1](https://127.0.0.1/41729/git/ttoss/compare/v0.13.0...v0.13.1) (2026-06-23)

### Features

* record per-node executions for orchestration runs ([#241](https://127.0.0.1/41729/git/ttoss/issues/241)) ([80cb1d6](https://127.0.0.1/41729/git/ttoss/commits/80cb1d6db9e828f8ff6bea86ae171826ddcfa43a))

# [0.13.0](https://github.com/ttoss/soat/compare/v0.12.5...v0.13.0) (2026-06-23)

### Features

* **oauth:** issue and rotate refresh tokens for MCP sessions ([#239](https://github.com/ttoss/soat/issues/239)) ([5f9d69d](https://github.com/ttoss/soat/commit/5f9d69d472ceb9c7a54db87d718c1e41a8254be7))

## [0.12.5](https://127.0.0.1/44727/git/ttoss/compare/v0.12.4...v0.12.5) (2026-06-23)

**Note:** Version bump only for package @soat/postgresdb

## [0.12.4](https://127.0.0.1/42309/git/ttoss/compare/v0.12.3...v0.12.4) (2026-06-22)

**Note:** Version bump only for package @soat/postgresdb

## [0.12.3](https://127.0.0.1/38839/git/ttoss/compare/v0.12.2...v0.12.3) (2026-06-22)

**Note:** Version bump only for package @soat/postgresdb

## [0.12.2](https://127.0.0.1/34481/git/ttoss/compare/v0.12.0...v0.12.2) (2026-06-21)

**Note:** Version bump only for package @soat/postgresdb

## [0.12.1](https://127.0.0.1/34481/git/ttoss/compare/v0.12.0...v0.12.1) (2026-06-21)

**Note:** Version bump only for package @soat/postgresdb

# [0.12.0](https://127.0.0.1/37599/git/ttoss/compare/v0.11.0...v0.12.0) (2026-06-21)

### Features

* **server:** replace in-memory OAuth stores with Postgres (A1+A2) ([#216](https://127.0.0.1/37599/git/ttoss/issues/216)) ([73544ea](https://127.0.0.1/37599/git/ttoss/commits/73544ea1a0f72d3361d33266f01211e36ebac2c5))

# [0.11.0](https://127.0.0.1/45259/git/ttoss/compare/v0.9.1...v0.11.0) (2026-06-13)

### Features

* **server:** deep-thinking reasoning — PRD reframe + provider-native effort + reflect mode ([#200](https://127.0.0.1/45259/git/ttoss/issues/200)) ([dec6192](https://127.0.0.1/45259/git/ttoss/commits/dec61927979ac72bbce33f3b5c6428fa228a9a56))

# [0.10.0](https://127.0.0.1/37241/git/ttoss/compare/v0.9.1...v0.10.0) (2026-06-13)

### Features

* **server:** deep-thinking reasoning — PRD reframe + provider-native effort + reflect mode ([#200](https://127.0.0.1/37241/git/ttoss/issues/200)) ([dec6192](https://127.0.0.1/37241/git/ttoss/commits/dec61927979ac72bbce33f3b5c6428fa228a9a56))

## [0.9.1](https://127.0.0.1/46713/git/ttoss/compare/v0.9.0...v0.9.1) (2026-06-12)

**Note:** Version bump only for package @soat/postgresdb

# [0.9.0](https://127.0.0.1/40289/git/ttoss/compare/v0.8.2...v0.9.0) (2026-06-11)

**Note:** Version bump only for package @soat/postgresdb

## [0.8.2](https://127.0.0.1/41431/git/ttoss/compare/v0.8.1...v0.8.2) (2026-06-11)

**Note:** Version bump only for package @soat/postgresdb

## [0.8.1](https://127.0.0.1/37303/git/ttoss/compare/v0.8.0...v0.8.1) (2026-06-10)

### Bug Fixes

* expire stale sessions during singleSessionPerActor conflict check ([#185](https://127.0.0.1/37303/git/ttoss/issues/185)) ([1b4dece](https://127.0.0.1/37303/git/ttoss/commits/1b4dece66cf4eb26fe39b1aebe48b8f1e0924fe6))

# 0.8.0 (2026-06-10)

### Bug Fixes

* issue 124 ([#125](https://127.0.0.1/36483/git/ttoss/issues/125)) ([b56320b](https://127.0.0.1/36483/git/ttoss/commits/b56320beddd901748a68fe21eb022821279e1eff))

### Features

* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://127.0.0.1/36483/git/ttoss/issues/137)) ([a72549b](https://127.0.0.1/36483/git/ttoss/commits/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://127.0.0.1/36483/git/ttoss/issues/135)
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://127.0.0.1/36483/git/ttoss/issues/144)) ([b242655](https://127.0.0.1/36483/git/ttoss/commits/b242655848ca9f3356ee6aa63bc13b9473bf787b))
* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/36483/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/36483/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://127.0.0.1/36483/git/ttoss/issues/133)) ([1c25329](https://127.0.0.1/36483/git/ttoss/commits/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://127.0.0.1/36483/git/ttoss/issues/129) [#132](https://127.0.0.1/36483/git/ttoss/issues/132)
* surface upstream AI provider errors and expose generation records ([#180](https://127.0.0.1/36483/git/ttoss/issues/180)) ([dde9578](https://127.0.0.1/36483/git/ttoss/commits/dde9578eed754cd4858ac45d25117ca13f1bc143))

## 0.7.1 (2026-06-09)

### Features

* agent tool output ([#121](https://127.0.0.1/46205/git/ttoss/issues/121)) ([8bd54eb](https://127.0.0.1/46205/git/ttoss/commits/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))
* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://127.0.0.1/46205/git/ttoss/issues/137)) ([a72549b](https://127.0.0.1/46205/git/ttoss/commits/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://127.0.0.1/46205/git/ttoss/issues/135)
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://127.0.0.1/46205/git/ttoss/issues/144)) ([b242655](https://127.0.0.1/46205/git/ttoss/commits/b242655848ca9f3356ee6aa63bc13b9473bf787b))
* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/46205/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/46205/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://127.0.0.1/46205/git/ttoss/issues/133)) ([1c25329](https://127.0.0.1/46205/git/ttoss/commits/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://127.0.0.1/46205/git/ttoss/issues/129) [#132](https://127.0.0.1/46205/git/ttoss/issues/132)

# 0.7.0 (2026-06-08)

### Features

* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://127.0.0.1/35569/git/ttoss/issues/137)) ([a72549b](https://127.0.0.1/35569/git/ttoss/commits/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://127.0.0.1/35569/git/ttoss/issues/135)
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://127.0.0.1/35569/git/ttoss/issues/144)) ([b242655](https://127.0.0.1/35569/git/ttoss/commits/b242655848ca9f3356ee6aa63bc13b9473bf787b))
* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/35569/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/35569/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://127.0.0.1/35569/git/ttoss/issues/133)) ([1c25329](https://127.0.0.1/35569/git/ttoss/commits/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://127.0.0.1/35569/git/ttoss/issues/129) [#132](https://127.0.0.1/35569/git/ttoss/issues/132)

## [0.6.13](https://github.com/ttoss/soat/compare/v0.6.12...v0.6.13) (2026-06-08)

**Note:** Version bump only for package @soat/postgresdb

## [0.6.12](https://127.0.0.1/33645/git/ttoss/compare/v0.6.10...v0.6.12) (2026-06-08)

**Note:** Version bump only for package @soat/postgresdb

## [0.6.11](https://127.0.0.1/46581/git/ttoss/compare/v0.6.10...v0.6.11) (2026-06-08)

**Note:** Version bump only for package @soat/postgresdb

## [0.6.10](https://127.0.0.1/38987/git/ttoss/compare/v0.6.6...v0.6.10) (2026-06-08)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/38987/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/38987/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.9](https://127.0.0.1/45289/git/ttoss/compare/v0.6.6...v0.6.9) (2026-06-08)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/45289/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/45289/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.9](https://127.0.0.1/45289/git/ttoss/compare/v0.6.6...v0.6.9) (2026-06-08)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/45289/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/45289/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.8](https://127.0.0.1/41727/git/ttoss/compare/v0.6.6...v0.6.8) (2026-06-08)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/41727/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/41727/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.8](https://127.0.0.1/41727/git/ttoss/compare/v0.6.6...v0.6.8) (2026-06-08)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/41727/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/41727/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.7](https://127.0.0.1/42723/git/ttoss/compare/v0.6.6...v0.6.7) (2026-06-07)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/42723/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/42723/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.7](https://127.0.0.1/42723/git/ttoss/compare/v0.6.6...v0.6.7) (2026-06-07)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/42723/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/42723/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.7](https://127.0.0.1/42723/git/ttoss/compare/v0.6.6...v0.6.7) (2026-06-07)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/42723/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/42723/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.7](https://127.0.0.1/34089/git/ttoss/compare/v0.6.6...v0.6.7) (2026-06-07)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/34089/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/34089/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.7](https://127.0.0.1/34089/git/ttoss/compare/v0.6.6...v0.6.7) (2026-06-07)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/34089/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/34089/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.7](https://127.0.0.1/34089/git/ttoss/compare/v0.6.6...v0.6.7) (2026-06-07)

### Features

* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/34089/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/34089/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))

## [0.6.6](https://github.com/ttoss/soat/compare/v0.6.5...v0.6.6) (2026-06-05)

**Note:** Version bump only for package @soat/postgresdb

## [0.6.5](https://github.com/ttoss/soat/compare/v0.6.4...v0.6.5) (2026-06-05)

### Features

* **sessions:** add idempotency_key to addSessionMessage ([#144](https://github.com/ttoss/soat/issues/144)) ([b242655](https://github.com/ttoss/soat/commit/b242655848ca9f3356ee6aa63bc13b9473bf787b))

## [0.6.4](https://github.com/ttoss/soat/compare/v0.6.3...v0.6.4) (2026-06-04)

**Note:** Version bump only for package @soat/postgresdb

## [0.6.3](https://github.com/ttoss/soat/compare/v0.6.2...v0.6.3) (2026-06-04)

### Features

* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://github.com/ttoss/soat/issues/137)) ([a72549b](https://github.com/ttoss/soat/commit/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://github.com/ttoss/soat/issues/135)
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://github.com/ttoss/soat/issues/133)) ([1c25329](https://github.com/ttoss/soat/commit/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://github.com/ttoss/soat/issues/129) [#132](https://github.com/ttoss/soat/issues/132)

## [0.6.2](https://github.com/ttoss/soat/compare/v0.6.1...v0.6.2) (2026-06-01)

**Note:** Version bump only for package @soat/postgresdb

## [0.6.1](https://github.com/ttoss/soat/compare/v0.6.0...v0.6.1) (2026-05-28)

### Bug Fixes

* db ids ([#118](https://github.com/ttoss/soat/issues/118)) ([80a0a4d](https://github.com/ttoss/soat/commit/80a0a4d7e79aa49b13b021fced6d4e12b741eb3a))

# [0.6.0](https://github.com/ttoss/soat/compare/v0.5.8...v0.6.0) (2026-05-26)

### Features

* orchestration ([#111](https://github.com/ttoss/soat/issues/111)) ([c80bc1c](https://github.com/ttoss/soat/commit/c80bc1c158fac40f27a9b3aea190a31eb12aaa8e))

## [0.5.8](https://github.com/ttoss/soat/compare/v0.5.7...v0.5.8) (2026-05-26)

**Note:** Version bump only for package @soat/postgresdb

## [0.5.7](https://github.com/ttoss/soat/compare/v0.5.6...v0.5.7) (2026-05-25)

### Bug Fixes

* formations ([#94](https://github.com/ttoss/soat/issues/94)) ([c4cee1f](https://github.com/ttoss/soat/commit/c4cee1f2ece14fd21d559f1ef55d506e01f88ae6))

## [0.5.6](https://github.com/ttoss/soat/compare/v0.5.5...v0.5.6) (2026-05-18)

**Note:** Version bump only for package @soat/postgresdb

## [0.5.5](https://github.com/ttoss/soat/compare/v0.5.4...v0.5.5) (2026-05-17)

**Note:** Version bump only for package @soat/postgresdb

## [0.5.4](https://github.com/ttoss/soat/compare/v0.5.3...v0.5.4) (2026-05-17)

**Note:** Version bump only for package @soat/postgresdb

## [0.5.3](https://github.com/ttoss/soat/compare/v0.5.2...v0.5.3) (2026-05-17)

### Features

* auto memory actors ([#84](https://github.com/ttoss/soat/issues/84)) ([6b5e182](https://github.com/ttoss/soat/commit/6b5e18228008bdcaebe88d556c28b2c06fee4f7a))

## [0.5.2](https://github.com/ttoss/soat/compare/v0.5.1...v0.5.2) (2026-05-15)

**Note:** Version bump only for package @soat/postgresdb

## [0.5.1](https://github.com/ttoss/soat/compare/v0.5.0...v0.5.1) (2026-05-13)

**Note:** Version bump only for package @soat/postgresdb

# [0.5.0](https://github.com/ttoss/soat/compare/v0.4.18...v0.5.0) (2026-05-13)

### Features

* new memories ([#82](https://github.com/ttoss/soat/issues/82)) ([94a6348](https://github.com/ttoss/soat/commit/94a6348457feb18e7d0e4f0eb1e537e0c5cbc71b))
* trace tree ([#81](https://github.com/ttoss/soat/issues/81)) ([d5e1c69](https://github.com/ttoss/soat/commit/d5e1c698bab222d352ef62ab00f743b0ecf7d1c8))

## [0.4.18](https://github.com/ttoss/soat/compare/v0.4.17...v0.4.18) (2026-05-08)

### Bug Fixes

* traces on database ([#79](https://github.com/ttoss/soat/issues/79)) ([dc41474](https://github.com/ttoss/soat/commit/dc414747ad870b97ed769caddb5d0954e2a8aa3a))

### Features

* memories crud ([3063c14](https://github.com/ttoss/soat/commit/3063c148a1c9e944c4a151afc3fe6c809956b104))

## [0.4.17](https://github.com/ttoss/soat/compare/v0.4.16...v0.4.17) (2026-05-03)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.16](https://github.com/ttoss/soat/compare/v0.4.15...v0.4.16) (2026-05-03)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.15](https://github.com/ttoss/soat/compare/v0.4.14...v0.4.15) (2026-05-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.14](https://github.com/ttoss/soat/compare/v0.4.13...v0.4.14) (2026-05-02)

### Bug Fixes

* database error ([da40af9](https://github.com/ttoss/soat/commit/da40af95f3bfcee2b3deceac089f17b4fe582b85))

## [0.4.13](https://github.com/ttoss/soat/compare/v0.4.12...v0.4.13) (2026-05-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.12](https://github.com/ttoss/soat/compare/v0.4.11...v0.4.12) (2026-05-02)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.11](https://github.com/ttoss/soat/compare/v0.4.10...v0.4.11) (2026-05-02)

### Features

* make Document embedding vector dimension configurable via EMBEDDING_DIMENSIONS ([#64](https://github.com/ttoss/soat/issues/64)) ([6b6e62b](https://github.com/ttoss/soat/commit/6b6e62b418fc304ba23731ae24ba6d73d250e766))

## [0.4.10](https://github.com/ttoss/soat/compare/v0.4.9...v0.4.10) (2026-05-02)

### Bug Fixes

* actors ([#59](https://github.com/ttoss/soat/issues/59)) ([5578c20](https://github.com/ttoss/soat/commit/5578c20fe3d506bf053a0967a569d7d8146f698e))

## [0.4.9](https://github.com/ttoss/soat/compare/v0.4.8...v0.4.9) (2026-04-29)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.8](https://github.com/ttoss/soat/compare/v0.4.7...v0.4.8) (2026-04-29)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.7](https://github.com/ttoss/soat/compare/v0.4.6...v0.4.7) (2026-04-28)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.6](https://github.com/ttoss/soat/compare/v0.4.5...v0.4.6) (2026-04-28)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.5](https://github.com/ttoss/soat/compare/v0.4.4...v0.4.5) (2026-04-28)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.4](https://github.com/ttoss/soat/compare/v0.4.3...v0.4.4) (2026-04-28)

### Bug Fixes

* permissions ([#44](https://github.com/ttoss/soat/issues/44)) ([03710c2](https://github.com/ttoss/soat/commit/03710c2e5520c64b14fda7febc7b710dad13192b))

## [0.4.3](https://github.com/ttoss/soat/compare/v0.4.2...v0.4.3) (2026-04-27)

**Note:** Version bump only for package @soat/postgresdb

## [0.4.2](https://github.com/ttoss/soat/compare/v0.4.1...v0.4.2) (2026-04-27)

**Note:** Version bump only for package @soat/postgresdb

# [0.4.0](https://github.com/ttoss/soat/compare/v0.3.4...v0.4.0) (2026-04-27)

### Features

* memory ([#43](https://github.com/ttoss/soat/issues/43)) ([b47ad63](https://github.com/ttoss/soat/commit/b47ad63ef8838e7a46831fb05d67ae619b2c3c29))

## [0.3.3](https://github.com/ttoss/soat/compare/v0.3.2...v0.3.3) (2026-04-23)

**Note:** Version bump only for package @soat/postgresdb

## [0.3.2](https://github.com/ttoss/soat/compare/v0.3.1...v0.3.2) (2026-04-23)

### Bug Fixes

* update packages ([0980fac](https://github.com/ttoss/soat/commit/0980faccf4ae058664dc53ba3c0868aba62d2dae))

# [0.3.0](https://github.com/ttoss/soat/compare/v0.2.0...v0.3.0) (2026-04-23)

### Features

* soat context ([#39](https://github.com/ttoss/soat/issues/39)) ([e08798f](https://github.com/ttoss/soat/commit/e08798f4721203103985f8e515b7610e3d9414e6))

# [0.2.0](https://github.com/ttoss/soat/compare/v0.1.1...v0.2.0) (2026-04-22)

### Features

* **conversations:** add actorId owner FK to Conversation ([#27](https://github.com/ttoss/soat/issues/27)) ([f134e08](https://github.com/ttoss/soat/commit/f134e08db109d4b09765e8480088f111eb5834ca))
* **conversations:** add metadata field to conversation messages ([#30](https://github.com/ttoss/soat/issues/30)) ([c064674](https://github.com/ttoss/soat/commit/c06467418324ff61febe7c68eac6a8528f7ff8df)), closes [#22](https://github.com/ttoss/soat/issues/22)
* session first implementation ([#37](https://github.com/ttoss/soat/issues/37)) ([2f5f143](https://github.com/ttoss/soat/commit/2f5f143eed9b88e693911ea1a6b9ce9be8933bb7))
* webhooks ([fa0b626](https://github.com/ttoss/soat/commit/fa0b62625d6e310358f9e66f6b0aeddee7c30ca4))

# [0.1.0](https://github.com/ttoss/soat/compare/v0.0.0-alpha.2...v0.1.0) (2026-04-20)

### Bug Fixes

* docs labels ([db6d6b6](https://github.com/ttoss/soat/commit/db6d6b654e3d6af326ec5cd2885ffc8e0bc1f8a6))

### Features

* agents ([#9](https://github.com/ttoss/soat/issues/9)) ([cf91736](https://github.com/ttoss/soat/commit/cf917369ea4a58a62e5b866876a36e56fc0fdb0e))
* chats ([#6](https://github.com/ttoss/soat/issues/6)) ([6143723](https://github.com/ttoss/soat/commit/61437232b9ab1dd2a72ba21b8608ca10c6ceaf2b))
* documents api first implementation ([a5b172f](https://github.com/ttoss/soat/commit/a5b172fe1e8c535a3c79799307ebe6de7860b5a5))

# 0.0.0-alpha.2 (2026-01-06)

### Bug Fixes

* add version ([de8fab4](https://github.com/ttoss/soat/commit/de8fab4e0d51ba0e06e0b29f9b26ea8d147d92a6))

### Features

* database working ([5a5d34d](https://github.com/ttoss/soat/commit/5a5d34d5820c0279b14f3a135b9a55f728cf8f65))
* files rest api ([957c8b0](https://github.com/ttoss/soat/commit/957c8b0aa2b5a1b96dd3da789be2552e7bf34599))
