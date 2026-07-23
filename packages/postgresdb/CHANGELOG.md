# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
