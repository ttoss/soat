# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.13.20](https://127.0.0.1/41729/git/ttoss/compare/v0.13.19...v0.13.20) (2026-07-05)

### Bug Fixes

* **tools:** surface real upstream status for failed http tool calls ([#397](https://127.0.0.1/41729/git/ttoss/issues/397)) ([0e7a1d8](https://127.0.0.1/41729/git/ttoss/commits/0e7a1d8942f078cf82bf96213a0e8dd982f89ab8))

## [0.13.19](https://127.0.0.1/41729/git/ttoss/compare/v0.13.18...v0.13.19) (2026-07-04)

* feat(agents)!: normalize reasoning pipeline to a single branches/rounds primitive (#390) ([6d7a7fa](https://127.0.0.1/41729/git/ttoss/commits/6d7a7faecddde711c804df84749686298384a755)), closes [#390](https://127.0.0.1/41729/git/ttoss/issues/390) [#388](https://127.0.0.1/41729/git/ttoss/issues/388)

### Bug Fixes

* finalize human/webhook-receive node execution record on resume ([#391](https://127.0.0.1/41729/git/ttoss/issues/391)) ([7ab68de](https://127.0.0.1/41729/git/ttoss/commits/7ab68de08667da079e7f3fda278468a431e68592))
* **orchestrations:** normalize output_mapping paths without state. prefix ([#389](https://127.0.0.1/41729/git/ttoss/issues/389)) ([4fbd9d4](https://127.0.0.1/41729/git/ttoss/commits/4fbd9d40715753897b2d900289170fd6e1dbd547)), closes [#383](https://127.0.0.1/41729/git/ttoss/issues/383)

### Features

* **agents:** allow inline tool definitions alongside tool_ids ([#387](https://127.0.0.1/41729/git/ttoss/issues/387)) ([8fda25b](https://127.0.0.1/41729/git/ttoss/commits/8fda25b6aee9b51548bf81a331727d161446179f))
* **orchestrations:** durable background run execution ([#374](https://127.0.0.1/41729/git/ttoss/issues/374)) ([96a510d](https://127.0.0.1/41729/git/ttoss/commits/96a510ddb94674726237d62dac8f7c507eb01d11)), closes [#366](https://127.0.0.1/41729/git/ttoss/issues/366)

### BREAKING CHANGES

* `kind`, `count`, and `perspectives` are removed from the
reasoning step schema; existing configs using them are rejected with
INVALID_REASONING_CONFIG. Use `branches` instead.

## [0.13.18](https://127.0.0.1/41729/git/ttoss/compare/v0.13.17...v0.13.18) (2026-07-03)

### Bug Fixes

* resolve six orchestration/MCP/formations bugs via red-green TDD ([#381](https://127.0.0.1/41729/git/ttoss/issues/381)) ([10edd2c](https://127.0.0.1/41729/git/ttoss/commits/10edd2c7563b7f2a12d778910c5209576b20624d))

## [0.13.17](https://127.0.0.1/41729/git/ttoss/compare/v0.13.16...v0.13.17) (2026-07-03)

### Bug Fixes

* scope soat tool trace/context injection to schemas that declare it ([#372](https://127.0.0.1/41729/git/ttoss/issues/372)) ([8b455d9](https://127.0.0.1/41729/git/ttoss/commits/8b455d990beee8d21f66fcf92df8159b40a4e4ce)), closes [#371](https://127.0.0.1/41729/git/ttoss/issues/371)

## [0.13.16](https://127.0.0.1/41729/git/ttoss/compare/v0.13.15...v0.13.16) (2026-07-03)

### Bug Fixes

* **generations:** expose metadata.extraction via GET /generations endpoints ([#362](https://127.0.0.1/41729/git/ttoss/issues/362)) ([64a8443](https://127.0.0.1/41729/git/ttoss/commits/64a84438049d575b93084724e50fb1e02f179a0a)), closes [#359](https://127.0.0.1/41729/git/ttoss/issues/359)
* **tools:** validate soat tool actions against the platform registry ([#364](https://127.0.0.1/41729/git/ttoss/issues/364)) ([b81bf11](https://127.0.0.1/41729/git/ttoss/commits/b81bf113a5221e29eb38f4f812961cdba359f32a)), closes [#358](https://127.0.0.1/41729/git/ttoss/issues/358)

### Features

* **agents:** add force delete for agents with dependent generations/traces ([#351](https://127.0.0.1/41729/git/ttoss/issues/351)) ([3ab07e4](https://127.0.0.1/41729/git/ttoss/commits/3ab07e4c89b14cad708cae72d4fa00cfa33af177)), closes [#343](https://127.0.0.1/41729/git/ttoss/issues/343)
* **projects:** add PROJECT_HAS_DEPENDENTS 409 and force-delete cascade ([#360](https://127.0.0.1/41729/git/ttoss/issues/360)) ([4642dab](https://127.0.0.1/41729/git/ttoss/commits/4642dab90a8edbfc7557c03dd3e14acdb9ddffce)), closes [343/#351](https://127.0.0.1/41729/git/ttoss/issues/351) [#353](https://127.0.0.1/41729/git/ttoss/issues/353)

## [0.13.15](https://127.0.0.1/41729/git/ttoss/compare/v0.13.14...v0.13.15) (2026-07-03)

### Bug Fixes

* **ingestion-rules:** correct audio converter tutorial for real providers ([#328](https://127.0.0.1/41729/git/ttoss/issues/328)) ([c10269e](https://127.0.0.1/41729/git/ttoss/commits/c10269e90d6a56c9d9d14ee8f7fc19e0bd655ccb))
* **knowledge:** inject retrieved knowledge as non-system reference content ([#342](https://127.0.0.1/41729/git/ttoss/issues/342)) ([3bf9702](https://127.0.0.1/41729/git/ttoss/commits/3bf970299cc3dec3c1d54ab2ac24f955fffbf8bd))

### Features

* **formations:** add orchestration resource type (agent squads) ([#341](https://127.0.0.1/41729/git/ttoss/issues/341)) ([0d86dbc](https://127.0.0.1/41729/git/ttoss/commits/0d86dbc453a09c470c1cb040d823a290f5affea6))
* **memories:** consolidate merges into a single fact via LLM (agent paths) ([#347](https://127.0.0.1/41729/git/ttoss/issues/347)) ([da3a367](https://127.0.0.1/41729/git/ttoss/commits/da3a367ad4b7beafc7586239e5c8c03df16d7fff))
* **tools:** add universal output_mapping field to reshape tool results ([#349](https://127.0.0.1/41729/git/ttoss/issues/349)) ([fb93b65](https://127.0.0.1/41729/git/ttoss/commits/fb93b65681fccdf11c22b76ab28ca1c65102101e)), closes [#346](https://127.0.0.1/41729/git/ttoss/issues/346)

## [0.13.14](https://127.0.0.1/41729/git/ttoss/compare/v0.13.13...v0.13.14) (2026-07-02)

### Bug Fixes

* **formations:** accept parameters on validate-formation ([#338](https://127.0.0.1/41729/git/ttoss/issues/338)) ([dcd0cd5](https://127.0.0.1/41729/git/ttoss/commits/dcd0cd56f4a128bc923b4325c115c3acb5a94f36)), closes [#319](https://127.0.0.1/41729/git/ttoss/issues/319)
* **tools:** resolve a bare-scalar pipeline output mapping ([#335](https://127.0.0.1/41729/git/ttoss/issues/335)) ([#337](https://127.0.0.1/41729/git/ttoss/issues/337)) ([91e74c9](https://127.0.0.1/41729/git/ttoss/commits/91e74c90601b55bd1a5909732696f8e1d432569b))

## [0.13.13](https://127.0.0.1/41729/git/ttoss/compare/v0.13.12...v0.13.13) (2026-07-02)

### Features

* **secrets:** generic {{secret:...}} reference syntax for tool configs and formation sub support ([#331](https://127.0.0.1/41729/git/ttoss/issues/331)) ([7dcf51f](https://127.0.0.1/41729/git/ttoss/commits/7dcf51f56b7ea05ad9940e89c2b4d0188ab02982))
* **tools:** support multipart/form-data requests in http tools ([#332](https://127.0.0.1/41729/git/ttoss/issues/332)) ([690e54b](https://127.0.0.1/41729/git/ttoss/commits/690e54b02e30e18d644afb5316aeb4f1165308ae)), closes [#329](https://127.0.0.1/41729/git/ttoss/issues/329)

## [0.13.12](https://127.0.0.1/41729/git/ttoss/compare/v0.13.11...v0.13.12) (2026-07-02)

### Bug Fixes

* **server:** resolve JSON Logic markers recursively in pipeline and orchestration input mappings ([#324](https://127.0.0.1/41729/git/ttoss/issues/324)) ([7f6e0cb](https://127.0.0.1/41729/git/ttoss/commits/7f6e0cbccda7e24a300a7f5514c4a39fa20c777c))

## [0.13.11](https://127.0.0.1/41729/git/ttoss/compare/v0.13.10...v0.13.11) (2026-07-02)

**Note:** Version bump only for package @soat/website

## [0.13.10](https://127.0.0.1/41729/git/ttoss/compare/v0.13.9...v0.13.10) (2026-07-01)

### Bug Fixes

* **files:** return 409 instead of 500 on duplicate path uploads ([#307](https://127.0.0.1/41729/git/ttoss/issues/307)) ([103a5b9](https://127.0.0.1/41729/git/ttoss/commits/103a5b9bc879478a7becf2844b817c52956603c2))
* **formations:** treat already-gone resources as deleted during teardown ([#311](https://127.0.0.1/41729/git/ttoss/issues/311)) ([7a06f3c](https://127.0.0.1/41729/git/ttoss/commits/7a06f3c29f47bda6cb1822321d5c83598cbf4def))

### Features

* **agents:** add output_schema for structured output generation ([#309](https://127.0.0.1/41729/git/ttoss/issues/309)) ([15c4e53](https://127.0.0.1/41729/git/ttoss/commits/15c4e536fd90305198686bae7327b7812c1a91b5))
* **files:** expose upload-file-with-token as an MCP tool ([#303](https://127.0.0.1/41729/git/ttoss/issues/303)) ([5c9796f](https://127.0.0.1/41729/git/ttoss/commits/5c9796f10c3a46d0d133b236eb0f976e6376a58d))

## [0.13.9](https://127.0.0.1/41729/git/ttoss/compare/v0.13.8...v0.13.9) (2026-06-29)

### Features

* **formations:** support use_previous_value for parameters on update ([#301](https://127.0.0.1/41729/git/ttoss/issues/301)) ([d270478](https://127.0.0.1/41729/git/ttoss/commits/d2704787907f389e51786f6cd6f7de37456152b7))
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

### Bug Fixes

* **agents:** address UX/docs issues from [#293](https://127.0.0.1/41729/git/ttoss/issues/293) (Bedrock, PATCH, unknown fields, trace_id) ([#294](https://127.0.0.1/41729/git/ttoss/issues/294)) ([31fafc6](https://127.0.0.1/41729/git/ttoss/commits/31fafc654844da7f62975a048a50a2590ba1e741))

### Features

* **projects:** add rename endpoint and fix project-scoped GET access ([#291](https://127.0.0.1/41729/git/ttoss/issues/291)) ([1e5723e](https://127.0.0.1/41729/git/ttoss/commits/1e5723ed4a8d08c3f1133d5c832d6f35369b4e9d))

## [0.13.7](https://127.0.0.1/41729/git/ttoss/compare/v0.13.6...v0.13.7) (2026-06-27)

* feat(reasoning)!: replace reflect/debate with a generic pipeline mode (#285) ([1bb12e8](https://127.0.0.1/41729/git/ttoss/commits/1bb12e8b02e116cec9bd0ff46fc48889ac1d34c9)), closes [#285](https://127.0.0.1/41729/git/ttoss/issues/285) [#286](https://127.0.0.1/41729/git/ttoss/issues/286)

### Bug Fixes

* **documents:** robust ingestion errors, status endpoint, and re-ingest ([#283](https://127.0.0.1/41729/git/ttoss/issues/283)) ([e4cc102](https://127.0.0.1/41729/git/ttoss/commits/e4cc102142368a409184f54b2ccdc3d3a5989257))

### Features

* **reasoning:** observability for deep-thinking deliberation ([#280](https://127.0.0.1/41729/git/ttoss/issues/280)) ([4cff79b](https://127.0.0.1/41729/git/ttoss/commits/4cff79bb4a85b4396d9b0cd39bb99369201e53b2))

### BREAKING CHANGES

* reasoning.mode no longer accepts `reflect` or `debate`, and
the `critique`/`perspectives`/`max_rounds`/`synthesis` fields are removed. Use
`mode: pipeline` with `steps`. Agents already stored with the old modes become
inert no-ops (the plain draft is returned).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G6ic7jk7gJdbkpzumsTAA2

## [0.13.7](https://127.0.0.1/41729/git/ttoss/compare/v0.13.6...v0.13.7) (2026-06-27)

* feat(reasoning)!: replace reflect/debate with a generic pipeline mode (#285) ([1bb12e8](https://127.0.0.1/41729/git/ttoss/commits/1bb12e8b02e116cec9bd0ff46fc48889ac1d34c9)), closes [#285](https://127.0.0.1/41729/git/ttoss/issues/285) [#286](https://127.0.0.1/41729/git/ttoss/issues/286)

### Bug Fixes

* **documents:** robust ingestion errors, status endpoint, and re-ingest ([#283](https://127.0.0.1/41729/git/ttoss/issues/283)) ([e4cc102](https://127.0.0.1/41729/git/ttoss/commits/e4cc102142368a409184f54b2ccdc3d3a5989257))

### Features

* **reasoning:** observability for deep-thinking deliberation ([#280](https://127.0.0.1/41729/git/ttoss/issues/280)) ([4cff79b](https://127.0.0.1/41729/git/ttoss/commits/4cff79bb4a85b4396d9b0cd39bb99369201e53b2))

### BREAKING CHANGES

* reasoning.mode no longer accepts `reflect` or `debate`, and
the `critique`/`perspectives`/`max_rounds`/`synthesis` fields are removed. Use
`mode: pipeline` with `steps`. Agents already stored with the old modes become
inert no-ops (the plain draft is returned).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G6ic7jk7gJdbkpzumsTAA2

## [0.13.6](https://127.0.0.1/41729/git/ttoss/compare/v0.13.5...v0.13.6) (2026-06-25)

### Features

* **files:** address files by prefix + filename, read-only path key ([#275](https://127.0.0.1/41729/git/ttoss/issues/275)) ([95edfc4](https://127.0.0.1/41729/git/ttoss/commits/95edfc43a5af81b3f65cd198b6eb4a16739a4954))

## [0.13.5](https://127.0.0.1/41729/git/ttoss/compare/v0.13.4...v0.13.5) (2026-06-25)

### Features

* **files:** add upload token endpoint for large file uploads via MCP ([#269](https://127.0.0.1/41729/git/ttoss/issues/269)) ([e62627c](https://127.0.0.1/41729/git/ttoss/commits/e62627c2409a1d8049f80fdd21fbd02e3ccbe29e))
* **server:** make projectId implicit for project-scoped API keys ([#270](https://127.0.0.1/41729/git/ttoss/issues/270)) ([026edb7](https://127.0.0.1/41729/git/ttoss/commits/026edb7446f3cb176ef33a2087facd719d9f5095)), closes [#267](https://127.0.0.1/41729/git/ttoss/issues/267) [#267](https://127.0.0.1/41729/git/ttoss/issues/267)

## [0.13.4](https://127.0.0.1/41729/git/ttoss/compare/v0.13.3...v0.13.4) (2026-06-25)

### Features

* add pipeline tool type for deterministic multi-step tool sequences ([#260](https://127.0.0.1/41729/git/ttoss/issues/260)) ([4a90872](https://127.0.0.1/41729/git/ttoss/commits/4a90872bcd7b073b663155c6a4be60e65d23cdbb))
* improve debate round visibility and trace generation embedding ([#259](https://127.0.0.1/41729/git/ttoss/issues/259)) ([b5fdbff](https://127.0.0.1/41729/git/ttoss/commits/b5fdbffd1ca83e6e43909bb4578747fb0eb2f81b))
* orchestration poll node (+ friendly durations, delay docs) ([#261](https://127.0.0.1/41729/git/ttoss/issues/261)) ([823702e](https://127.0.0.1/41729/git/ttoss/commits/823702eddf05d1a56242f7d7ab3c86cf0dbb0806))

## [0.13.3](https://127.0.0.1/41729/git/ttoss/compare/v0.13.2...v0.13.3) (2026-06-24)

### Bug Fixes

* expose debate perspective outputs as child generation records ([#251](https://127.0.0.1/41729/git/ttoss/issues/251)) ([d8308d6](https://127.0.0.1/41729/git/ttoss/commits/d8308d6aa65b20848f33ef7cf11ce5fba613f338))

### Features

* **documents:** async file ingestion with 202 + job status polling ([#250](https://127.0.0.1/41729/git/ttoss/issues/250)) ([9e07595](https://127.0.0.1/41729/git/ttoss/commits/9e075959068ddd277c5db892f3f4defb73a96979))
* **knowledge:** expose memory_name in knowledge results; align memory embedding docs ([#252](https://127.0.0.1/41729/git/ttoss/issues/252)) ([60df773](https://127.0.0.1/41729/git/ttoss/commits/60df773061b1555e44f6b5b2f32d47955f868888)), closes [#2](https://127.0.0.1/41729/git/ttoss/issues/2) [#1](https://127.0.0.1/41729/git/ttoss/issues/1)
* **orchestrations:** record skipped node executions on completed runs ([#253](https://127.0.0.1/41729/git/ttoss/issues/253)) ([0a6f9b9](https://127.0.0.1/41729/git/ttoss/commits/0a6f9b9849fa73d90d89c850c01b7e424d7f796e))

## [0.13.2](https://127.0.0.1/41729/git/ttoss/compare/v0.13.1...v0.13.2) (2026-06-24)

### Features

* **documents:** native file ingestion with DocumentChunk model ([#245](https://127.0.0.1/41729/git/ttoss/issues/245)) ([5e9776c](https://127.0.0.1/41729/git/ttoss/commits/5e9776c9c01d456a360b6c5ae595098d87bfcb24))

## [0.13.1](https://127.0.0.1/41729/git/ttoss/compare/v0.13.0...v0.13.1) (2026-06-23)

* Make orchestration run input usable: object MCP schema + JSON Logic inputMapping (#240) ([3cadc79](https://127.0.0.1/41729/git/ttoss/commits/3cadc79612d3cecbbe079fdea83f47c0c4de0dab)), closes [#240](https://127.0.0.1/41729/git/ttoss/issues/240)

### Features

* **orchestrations:** static validation for graphs and input_mapping ([#242](https://127.0.0.1/41729/git/ttoss/issues/242)) ([c3a6e10](https://127.0.0.1/41729/git/ttoss/commits/c3a6e109fd8142137cecf96f8e26775dcf28d700))
* record per-node executions for orchestration runs ([#241](https://127.0.0.1/41729/git/ttoss/issues/241)) ([80cb1d6](https://127.0.0.1/41729/git/ttoss/commits/80cb1d6db9e828f8ff6bea86ae171826ddcfa43a))

### BREAKING CHANGES

* inputMapping values are no longer `state.<key>` path
strings. A bare string is now a literal; use `{var: 'key'}` to read from
state. outputMapping is unchanged (still a state path — JSON Logic cannot
express a write target). Tutorial, module docs, smoke tests, and unit tests
migrated to the new syntax.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01452qqr3rQwdrBTmGnwtLtc

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

## [0.12.5](https://127.0.0.1/44727/git/ttoss/compare/v0.12.4...v0.12.5) (2026-06-23)

### Bug Fixes

* **bedrock:** support apiKey-based auth for AWS Bedrock API keys ([#236](https://127.0.0.1/44727/git/ttoss/issues/236)) ([e807539](https://127.0.0.1/44727/git/ttoss/commits/e8075393a4fc1dfe35aab401417528e5cc145a59))

## [0.12.4](https://127.0.0.1/42309/git/ttoss/compare/v0.12.3...v0.12.4) (2026-06-22)

**Note:** Version bump only for package @soat/website

## [0.12.3](https://127.0.0.1/38839/git/ttoss/compare/v0.12.2...v0.12.3) (2026-06-22)

### Features

* **docs:** add docs module exposing platform documentation via REST and MCP ([#226](https://127.0.0.1/38839/git/ttoss/issues/226)) ([7cba13a](https://127.0.0.1/38839/git/ttoss/commits/7cba13a239a124e4e61e9a56a17d6753e6b5869e)), closes [#214](https://127.0.0.1/38839/git/ttoss/issues/214)
* **embeddings:** add POST /api/v1/embeddings endpoint ([#224](https://127.0.0.1/38839/git/ttoss/issues/224)) ([789e3b6](https://127.0.0.1/38839/git/ttoss/commits/789e3b68253b1681c047f7e7790d5fbe920667d0))
* **website:** apply SOAT design system visual polish ([#227](https://127.0.0.1/38839/git/ttoss/issues/227)) ([de0db47](https://127.0.0.1/38839/git/ttoss/commits/de0db47f6287de26eee3c158f0e2e3b983dc8c3d)), closes [#080c14](https://127.0.0.1/38839/git/ttoss/issues/080c14)

## [0.12.2](https://127.0.0.1/34481/git/ttoss/compare/v0.12.0...v0.12.2) (2026-06-21)

### Features

* **mcp:** enable stateful mode to return Mcp-Session-Id on initialize ([#220](https://127.0.0.1/34481/git/ttoss/issues/220)) ([ae48fb9](https://127.0.0.1/34481/git/ttoss/commits/ae48fb956ccf4d56227d609a4b584f3fb6d16a32))

## [0.12.1](https://127.0.0.1/34481/git/ttoss/compare/v0.12.0...v0.12.1) (2026-06-21)

### Features

* **mcp:** enable stateful mode to return Mcp-Session-Id on initialize ([#220](https://127.0.0.1/34481/git/ttoss/issues/220)) ([ae48fb9](https://127.0.0.1/34481/git/ttoss/commits/ae48fb956ccf4d56227d609a4b584f3fb6d16a32))

# [0.12.0](https://127.0.0.1/37599/git/ttoss/compare/v0.11.0...v0.12.0) (2026-06-21)

### Features

* **app,website:** implement SOAT design system ([#214](https://127.0.0.1/37599/git/ttoss/issues/214)) ([73aad7b](https://127.0.0.1/37599/git/ttoss/commits/73aad7b1bb0c2108ec3c10086969806f6da7c4c2))
* **server:** OAuth 2.1 consent screen for MCP ([#212](https://127.0.0.1/37599/git/ttoss/issues/212)) ([d1d4b21](https://127.0.0.1/37599/git/ttoss/commits/d1d4b21813e575652b7fec1593d737df6b3711a6))

# [0.11.0](https://127.0.0.1/45259/git/ttoss/compare/v0.9.1...v0.11.0) (2026-06-13)

### Features

* debate mode — Phase 2 multi-perspective deliberation ([#202](https://127.0.0.1/45259/git/ttoss/issues/202)) ([d3e66c3](https://127.0.0.1/45259/git/ttoss/commits/d3e66c3e19aeafb941d285e4008b2eddede8ada8))
* **server:** deep-thinking reasoning — PRD reframe + provider-native effort + reflect mode ([#200](https://127.0.0.1/45259/git/ttoss/issues/200)) ([dec6192](https://127.0.0.1/45259/git/ttoss/commits/dec61927979ac72bbce33f3b5c6428fa228a9a56))

# [0.10.0](https://127.0.0.1/37241/git/ttoss/compare/v0.9.1...v0.10.0) (2026-06-13)

### Features

* debate mode — Phase 2 multi-perspective deliberation ([#202](https://127.0.0.1/37241/git/ttoss/issues/202)) ([d3e66c3](https://127.0.0.1/37241/git/ttoss/commits/d3e66c3e19aeafb941d285e4008b2eddede8ada8))
* **server:** deep-thinking reasoning — PRD reframe + provider-native effort + reflect mode ([#200](https://127.0.0.1/37241/git/ttoss/issues/200)) ([dec6192](https://127.0.0.1/37241/git/ttoss/commits/dec61927979ac72bbce33f3b5c6428fa228a9a56))

## [0.9.1](https://127.0.0.1/46713/git/ttoss/compare/v0.9.0...v0.9.1) (2026-06-12)

**Note:** Version bump only for package @soat/website

# [0.9.0](https://127.0.0.1/40289/git/ttoss/compare/v0.8.2...v0.9.0) (2026-06-11)

### Features

* **tools:** support ${body.xxx} path parameter interpolation in HTTP tool URLs ([#195](https://127.0.0.1/40289/git/ttoss/issues/195)) ([85f8eb4](https://127.0.0.1/40289/git/ttoss/commits/85f8eb43bf65a47330c3a2b7a25ed94693ccd894)), closes [#194](https://127.0.0.1/40289/git/ttoss/issues/194)

## [0.8.2](https://127.0.0.1/41431/git/ttoss/compare/v0.8.1...v0.8.2) (2026-06-11)

### Bug Fixes

* **sessions:** persist and honor inactivity_ttl_seconds ([#192](https://127.0.0.1/41431/git/ttoss/issues/192)) ([dabb6a7](https://127.0.0.1/41431/git/ttoss/commits/dabb6a7219720e344b9f1542e614b6c6a31fb723)), closes [#189](https://127.0.0.1/41431/git/ttoss/issues/189)

## [0.8.1](https://127.0.0.1/37303/git/ttoss/compare/v0.8.0...v0.8.1) (2026-06-10)

**Note:** Version bump only for package @soat/website

# 0.8.0 (2026-06-10)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://127.0.0.1/36483/git/ttoss/issues/114)) ([906dd0c](https://127.0.0.1/36483/git/ttoss/commits/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))
* issue 124 ([#125](https://127.0.0.1/36483/git/ttoss/issues/125)) ([b56320b](https://127.0.0.1/36483/git/ttoss/commits/b56320beddd901748a68fe21eb022821279e1eff))

### Features

* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://127.0.0.1/36483/git/ttoss/issues/137)) ([a72549b](https://127.0.0.1/36483/git/ttoss/commits/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://127.0.0.1/36483/git/ttoss/issues/135)
* context window limiting and trace lifecycle fix (issue [#129](https://127.0.0.1/36483/git/ttoss/issues/129)) ([#134](https://127.0.0.1/36483/git/ttoss/issues/134)) ([2688612](https://127.0.0.1/36483/git/ttoss/commits/268861201365de568d62ee16c51c33bfc7b41206))
* **sessions:** add expired status with lazy TTL update ([#138](https://127.0.0.1/36483/git/ttoss/issues/138)) ([2fc6a0c](https://127.0.0.1/36483/git/ttoss/commits/2fc6a0cdc6f5dea7b10c4737a2bf3d1eea723b22))
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://127.0.0.1/36483/git/ttoss/issues/144)) ([b242655](https://127.0.0.1/36483/git/ttoss/commits/b242655848ca9f3356ee6aa63bc13b9473bf787b))
* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/36483/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/36483/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://127.0.0.1/36483/git/ttoss/issues/133)) ([1c25329](https://127.0.0.1/36483/git/ttoss/commits/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://127.0.0.1/36483/git/ttoss/issues/129) [#132](https://127.0.0.1/36483/git/ttoss/issues/132)
* surface upstream AI provider errors and expose generation records ([#180](https://127.0.0.1/36483/git/ttoss/issues/180)) ([dde9578](https://127.0.0.1/36483/git/ttoss/commits/dde9578eed754cd4858ac45d25117ca13f1bc143))

## 0.7.1 (2026-06-09)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://127.0.0.1/46205/git/ttoss/issues/114)) ([906dd0c](https://127.0.0.1/46205/git/ttoss/commits/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))
* issue 124 ([#125](https://127.0.0.1/46205/git/ttoss/issues/125)) ([b56320b](https://127.0.0.1/46205/git/ttoss/commits/b56320beddd901748a68fe21eb022821279e1eff))

### Features

* agent tool output ([#121](https://127.0.0.1/46205/git/ttoss/issues/121)) ([8bd54eb](https://127.0.0.1/46205/git/ttoss/commits/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))
* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://127.0.0.1/46205/git/ttoss/issues/137)) ([a72549b](https://127.0.0.1/46205/git/ttoss/commits/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://127.0.0.1/46205/git/ttoss/issues/135)
* context window limiting and trace lifecycle fix (issue [#129](https://127.0.0.1/46205/git/ttoss/issues/129)) ([#134](https://127.0.0.1/46205/git/ttoss/issues/134)) ([2688612](https://127.0.0.1/46205/git/ttoss/commits/268861201365de568d62ee16c51c33bfc7b41206))
* **sessions:** add expired status with lazy TTL update ([#138](https://127.0.0.1/46205/git/ttoss/issues/138)) ([2fc6a0c](https://127.0.0.1/46205/git/ttoss/commits/2fc6a0cdc6f5dea7b10c4737a2bf3d1eea723b22))
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://127.0.0.1/46205/git/ttoss/issues/144)) ([b242655](https://127.0.0.1/46205/git/ttoss/commits/b242655848ca9f3356ee6aa63bc13b9473bf787b))
* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/46205/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/46205/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://127.0.0.1/46205/git/ttoss/issues/133)) ([1c25329](https://127.0.0.1/46205/git/ttoss/commits/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://127.0.0.1/46205/git/ttoss/issues/129) [#132](https://127.0.0.1/46205/git/ttoss/issues/132)

# 0.7.0 (2026-06-08)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://127.0.0.1/35569/git/ttoss/issues/114)) ([906dd0c](https://127.0.0.1/35569/git/ttoss/commits/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))
* issue 124 ([#125](https://127.0.0.1/35569/git/ttoss/issues/125)) ([b56320b](https://127.0.0.1/35569/git/ttoss/commits/b56320beddd901748a68fe21eb022821279e1eff))

### Features

* agent tool output ([#121](https://127.0.0.1/35569/git/ttoss/issues/121)) ([8bd54eb](https://127.0.0.1/35569/git/ttoss/commits/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))
* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://127.0.0.1/35569/git/ttoss/issues/137)) ([a72549b](https://127.0.0.1/35569/git/ttoss/commits/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://127.0.0.1/35569/git/ttoss/issues/135)
* context window limiting and trace lifecycle fix (issue [#129](https://127.0.0.1/35569/git/ttoss/issues/129)) ([#134](https://127.0.0.1/35569/git/ttoss/issues/134)) ([2688612](https://127.0.0.1/35569/git/ttoss/commits/268861201365de568d62ee16c51c33bfc7b41206))
* **sessions:** add expired status with lazy TTL update ([#138](https://127.0.0.1/35569/git/ttoss/issues/138)) ([2fc6a0c](https://127.0.0.1/35569/git/ttoss/commits/2fc6a0cdc6f5dea7b10c4737a2bf3d1eea723b22))
* **sessions:** add idempotency_key to addSessionMessage ([#144](https://127.0.0.1/35569/git/ttoss/issues/144)) ([b242655](https://127.0.0.1/35569/git/ttoss/commits/b242655848ca9f3356ee6aa63bc13b9473bf787b))
* **sessions:** add message_delay_seconds for debounced LLM processing ([#148](https://127.0.0.1/35569/git/ttoss/issues/148)) ([1406654](https://127.0.0.1/35569/git/ttoss/commits/1406654ac85a2971220358591cfb73e9a96c1e51))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://127.0.0.1/35569/git/ttoss/issues/133)) ([1c25329](https://127.0.0.1/35569/git/ttoss/commits/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://127.0.0.1/35569/git/ttoss/issues/129) [#132](https://127.0.0.1/35569/git/ttoss/issues/132)

## [0.6.13](https://github.com/ttoss/soat/compare/v0.6.12...v0.6.13) (2026-06-08)

**Note:** Version bump only for package @soat/website

## [0.6.12](https://127.0.0.1/33645/git/ttoss/compare/v0.6.10...v0.6.12) (2026-06-08)

**Note:** Version bump only for package @soat/website

## [0.6.11](https://127.0.0.1/46581/git/ttoss/compare/v0.6.10...v0.6.11) (2026-06-08)

**Note:** Version bump only for package @soat/website

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

**Note:** Version bump only for package @soat/website

## [0.6.5](https://github.com/ttoss/soat/compare/v0.6.4...v0.6.5) (2026-06-05)

### Features

* **sessions:** add idempotency_key to addSessionMessage ([#144](https://github.com/ttoss/soat/issues/144)) ([b242655](https://github.com/ttoss/soat/commit/b242655848ca9f3356ee6aa63bc13b9473bf787b))

## [0.6.4](https://github.com/ttoss/soat/compare/v0.6.3...v0.6.4) (2026-06-04)

**Note:** Version bump only for package @soat/website

## [0.6.3](https://github.com/ttoss/soat/compare/v0.6.2...v0.6.3) (2026-06-04)

### Bug Fixes

* add shell-safe @VAR_NAME and bare-key syntax to --parameter for --env-file integration ([#114](https://github.com/ttoss/soat/issues/114)) ([906dd0c](https://github.com/ttoss/soat/commit/906dd0cf79a1d5b6cd312e7489ac6a549c3e011b))

### Features

* **agents:** single_session_per_actor — enforce one open session per actor ([#137](https://github.com/ttoss/soat/issues/137)) ([a72549b](https://github.com/ttoss/soat/commit/a72549beb78eb7381156c8a355dd86f7bca94a31)), closes [#135](https://github.com/ttoss/soat/issues/135)
* context window limiting and trace lifecycle fix (issue [#129](https://github.com/ttoss/soat/issues/129)) ([#134](https://github.com/ttoss/soat/issues/134)) ([2688612](https://github.com/ttoss/soat/commit/268861201365de568d62ee16c51c33bfc7b41206))
* **sessions:** add expired status with lazy TTL update ([#138](https://github.com/ttoss/soat/issues/138)) ([2fc6a0c](https://github.com/ttoss/soat/commit/2fc6a0cdc6f5dea7b10c4737a2bf3d1eea723b22))
* **sessions:** session auto-expiry via inactivity TTL ([#133](https://github.com/ttoss/soat/issues/133)) ([1c25329](https://github.com/ttoss/soat/commit/1c253291a94a5e9d27b537842ac57c9bde5a467e)), closes [#129](https://github.com/ttoss/soat/issues/129) [#132](https://github.com/ttoss/soat/issues/132)

## [0.6.2](https://github.com/ttoss/soat/compare/v0.6.1...v0.6.2) (2026-06-01)

### Bug Fixes

* issue 124 ([#125](https://github.com/ttoss/soat/issues/125)) ([b56320b](https://github.com/ttoss/soat/commit/b56320beddd901748a68fe21eb022821279e1eff))

### Features

* agent tool output ([#121](https://github.com/ttoss/soat/issues/121)) ([8bd54eb](https://github.com/ttoss/soat/commit/8bd54eb3a4c5adce111f30f52203b80bd04ca45c))

## [0.6.1](https://github.com/ttoss/soat/compare/v0.6.0...v0.6.1) (2026-05-28)

### Bug Fixes

* db ids ([#118](https://github.com/ttoss/soat/issues/118)) ([80a0a4d](https://github.com/ttoss/soat/commit/80a0a4d7e79aa49b13b021fced6d4e12b741eb3a))

# [0.6.0](https://github.com/ttoss/soat/compare/v0.5.8...v0.6.0) (2026-05-26)

### Features

* orchestration ([#111](https://github.com/ttoss/soat/issues/111)) ([c80bc1c](https://github.com/ttoss/soat/commit/c80bc1c158fac40f27a9b3aea190a31eb12aaa8e))

## [0.5.8](https://github.com/ttoss/soat/compare/v0.5.7...v0.5.8) (2026-05-26)

### Features

* expose webhook secret via GET endpoint and ref_attr formation output ([#107](https://github.com/ttoss/soat/issues/107)) ([a0691d7](https://github.com/ttoss/soat/commit/a0691d7dd778109092d2aba6d5cd60b9c9392436))

## [0.5.7](https://github.com/ttoss/soat/compare/v0.5.6...v0.5.7) (2026-05-25)

### Bug Fixes

* agents bugs ([#95](https://github.com/ttoss/soat/issues/95)) ([1084467](https://github.com/ttoss/soat/commit/108446771a5e1b279f00610ea070d8a15b2ee6ef))
* formations ([#94](https://github.com/ttoss/soat/issues/94)) ([c4cee1f](https://github.com/ttoss/soat/commit/c4cee1f2ece14fd21d559f1ef55d506e01f88ae6))

## [0.5.6](https://github.com/ttoss/soat/compare/v0.5.5...v0.5.6) (2026-05-18)

### Bug Fixes

* issue 89 ([#90](https://github.com/ttoss/soat/issues/90)) ([890c2ed](https://github.com/ttoss/soat/commit/890c2edc7b246e6f9f4f5faaffefe4a71b9fa585))

## [0.5.5](https://github.com/ttoss/soat/compare/v0.5.4...v0.5.5) (2026-05-17)

### Features

* cli wrappers ([#88](https://github.com/ttoss/soat/issues/88)) ([88befab](https://github.com/ttoss/soat/commit/88befab2ef24172f080dd896b4aa45af704ac817))

## [0.5.4](https://github.com/ttoss/soat/compare/v0.5.3...v0.5.4) (2026-05-17)

### Features

* add Parameters support to Agent Formations (CloudFormation-style) ([#86](https://github.com/ttoss/soat/issues/86)) ([69e5f4e](https://github.com/ttoss/soat/commit/69e5f4ef2cf4aa3493f909c3a32bfb856868a47b))

## [0.5.3](https://github.com/ttoss/soat/compare/v0.5.2...v0.5.3) (2026-05-17)

### Features

* auto memory actors ([#84](https://github.com/ttoss/soat/issues/84)) ([6b5e182](https://github.com/ttoss/soat/commit/6b5e18228008bdcaebe88d556c28b2c06fee4f7a))

## [0.5.2](https://github.com/ttoss/soat/compare/v0.5.1...v0.5.2) (2026-05-15)

### Bug Fixes

* server lint ([65e0169](https://github.com/ttoss/soat/commit/65e0169bb13c19f92457bbb440a62529fe7492a3))

## [0.5.1](https://github.com/ttoss/soat/compare/v0.5.0...v0.5.1) (2026-05-13)

### Features

* write memory agent ([7d02020](https://github.com/ttoss/soat/commit/7d02020aa873bc53017c155beb0adbe27dd62cd8))

# [0.5.0](https://github.com/ttoss/soat/compare/v0.4.18...v0.5.0) (2026-05-13)

### Features

* new memories ([#82](https://github.com/ttoss/soat/issues/82)) ([94a6348](https://github.com/ttoss/soat/commit/94a6348457feb18e7d0e4f0eb1e537e0c5cbc71b))
* trace tree ([#81](https://github.com/ttoss/soat/issues/81)) ([d5e1c69](https://github.com/ttoss/soat/commit/d5e1c698bab222d352ef62ab00f743b0ecf7d1c8))

## [0.4.18](https://github.com/ttoss/soat/compare/v0.4.17...v0.4.18) (2026-05-08)

### Bug Fixes

* traces on database ([#79](https://github.com/ttoss/soat/issues/79)) ([dc41474](https://github.com/ttoss/soat/commit/dc414747ad870b97ed769caddb5d0954e2a8aa3a))
* tutorials ([b857db5](https://github.com/ttoss/soat/commit/b857db51541580398acb628141b22b1857553f1e))

### Features

* memories crud ([3063c14](https://github.com/ttoss/soat/commit/3063c148a1c9e944c4a151afc3fe6c809956b104))

## [0.4.17](https://github.com/ttoss/soat/compare/v0.4.16...v0.4.17) (2026-05-03)

**Note:** Version bump only for package @soat/website

## [0.4.16](https://github.com/ttoss/soat/compare/v0.4.15...v0.4.16) (2026-05-03)

### Features

* **sessions:** implement cancel-previous to replace snapshot-position ordering fix ([#75](https://github.com/ttoss/soat/issues/75)) ([5f19d63](https://github.com/ttoss/soat/commit/5f19d637ed8353858631665987e6d8d44c70eac6))

## [0.4.15](https://github.com/ttoss/soat/compare/v0.4.14...v0.4.15) (2026-05-02)

**Note:** Version bump only for package @soat/website

## [0.4.14](https://github.com/ttoss/soat/compare/v0.4.13...v0.4.14) (2026-05-02)

### Bug Fixes

* database error ([da40af9](https://github.com/ttoss/soat/commit/da40af95f3bfcee2b3deceac089f17b4fe582b85))

## [0.4.13](https://github.com/ttoss/soat/compare/v0.4.12...v0.4.13) (2026-05-02)

**Note:** Version bump only for package @soat/website

## [0.4.12](https://github.com/ttoss/soat/compare/v0.4.11...v0.4.12) (2026-05-02)

**Note:** Version bump only for package @soat/website

## [0.4.11](https://github.com/ttoss/soat/compare/v0.4.10...v0.4.11) (2026-05-02)

### Bug Fixes

* descriptive API errors for known failures + Linux Docker/Ollama docs ([#66](https://github.com/ttoss/soat/issues/66)) ([918fe0a](https://github.com/ttoss/soat/commit/918fe0a96e0d4d6b114310cb0ef76617812bcc8e))

### Features

* require `ai_provider_id` for chat completions — remove hardcoded `qwen2.5:0.5b` fallback ([#65](https://github.com/ttoss/soat/issues/65)) ([1c37826](https://github.com/ttoss/soat/commit/1c378260c8b7378e7a4e512920df07c37c262538))

## [0.4.10](https://github.com/ttoss/soat/compare/v0.4.9...v0.4.10) (2026-05-02)

### Bug Fixes

* actors ([#59](https://github.com/ttoss/soat/issues/59)) ([5578c20](https://github.com/ttoss/soat/commit/5578c20fe3d506bf053a0967a569d7d8146f698e))
* add error logs ([2e95374](https://github.com/ttoss/soat/commit/2e9537470cf75c8e71b6472a3d2c18d885334094))

## [0.4.9](https://github.com/ttoss/soat/compare/v0.4.8...v0.4.9) (2026-04-29)

**Note:** Version bump only for package @soat/website

## [0.4.8](https://github.com/ttoss/soat/compare/v0.4.7...v0.4.8) (2026-04-29)

### Features

* add GET /api/v1/api-keys list endpoint with JWT/API key scoping ([#51](https://github.com/ttoss/soat/issues/51)) ([f60338a](https://github.com/ttoss/soat/commit/f60338af87b33295c142ce53fb9d2fcad53a5d03))

## [0.4.7](https://github.com/ttoss/soat/compare/v0.4.6...v0.4.7) (2026-04-28)

### Bug Fixes

* apis ([#48](https://github.com/ttoss/soat/issues/48)) ([f71415f](https://github.com/ttoss/soat/commit/f71415f93f2ec5562cf0af9e2e31ae3a41cc6513))

## [0.4.6](https://github.com/ttoss/soat/compare/v0.4.5...v0.4.6) (2026-04-28)

**Note:** Version bump only for package @soat/website

## [0.4.5](https://github.com/ttoss/soat/compare/v0.4.4...v0.4.5) (2026-04-28)

### Bug Fixes

* ids ([#45](https://github.com/ttoss/soat/issues/45)) ([a106f58](https://github.com/ttoss/soat/commit/a106f5874f272d6edbbe735dd48113488417e78a))

## [0.4.4](https://github.com/ttoss/soat/compare/v0.4.3...v0.4.4) (2026-04-28)

### Bug Fixes

* permissions ([#44](https://github.com/ttoss/soat/issues/44)) ([03710c2](https://github.com/ttoss/soat/commit/03710c2e5520c64b14fda7febc7b710dad13192b))

## [0.4.3](https://github.com/ttoss/soat/compare/v0.4.2...v0.4.3) (2026-04-27)

**Note:** Version bump only for package @soat/website

## [0.4.2](https://github.com/ttoss/soat/compare/v0.4.1...v0.4.2) (2026-04-27)

**Note:** Version bump only for package @soat/website

# [0.4.0](https://github.com/ttoss/soat/compare/v0.3.4...v0.4.0) (2026-04-27)

### Bug Fixes

* website ([b689300](https://github.com/ttoss/soat/commit/b6893000e3d0fdeb7cbdcc0b90ac7ab865d895a5))

### Features

* memory ([#43](https://github.com/ttoss/soat/issues/43)) ([b47ad63](https://github.com/ttoss/soat/commit/b47ad63ef8838e7a46831fb05d67ae619b2c3c29))

## [0.3.4](https://github.com/ttoss/soat/compare/v0.3.3...v0.3.4) (2026-04-24)

**Note:** Version bump only for package @soat/website

## [0.3.3](https://github.com/ttoss/soat/compare/v0.3.2...v0.3.3) (2026-04-23)

**Note:** Version bump only for package @soat/website

## [0.3.2](https://github.com/ttoss/soat/compare/v0.3.1...v0.3.2) (2026-04-23)

### Bug Fixes

* update packages ([0980fac](https://github.com/ttoss/soat/commit/0980faccf4ae058664dc53ba3c0868aba62d2dae))

# [0.3.0](https://github.com/ttoss/soat/compare/v0.2.0...v0.3.0) (2026-04-23)

### Features

* soat context ([#39](https://github.com/ttoss/soat/issues/39)) ([e08798f](https://github.com/ttoss/soat/commit/e08798f4721203103985f8e515b7610e3d9414e6))

# [0.2.0](https://github.com/ttoss/soat/compare/v0.1.1...v0.2.0) (2026-04-22)

### Bug Fixes

* docs build ([c30d3be](https://github.com/ttoss/soat/commit/c30d3be363a23e41789d4fb80d329d3f8cf3a32b))

### Features

* **actors:** add externalId for idempotent actor creation ([#26](https://github.com/ttoss/soat/issues/26)) ([2c91282](https://github.com/ttoss/soat/commit/2c912821f9e596b4d46df2cfced1becb79ecc4ab)), closes [#21](https://github.com/ttoss/soat/issues/21)
* **conversations:** add actorId owner FK to Conversation ([#27](https://github.com/ttoss/soat/issues/27)) ([f134e08](https://github.com/ttoss/soat/commit/f134e08db109d4b09765e8480088f111eb5834ca))
* **conversations:** add metadata field to conversation messages ([#30](https://github.com/ttoss/soat/issues/30)) ([c064674](https://github.com/ttoss/soat/commit/c06467418324ff61febe7c68eac6a8528f7ff8df)), closes [#22](https://github.com/ttoss/soat/issues/22)
* session first implementation ([#37](https://github.com/ttoss/soat/issues/37)) ([2f5f143](https://github.com/ttoss/soat/commit/2f5f143eed9b88e693911ea1a6b9ce9be8933bb7))
* webhooks ([fa0b626](https://github.com/ttoss/soat/commit/fa0b62625d6e310358f9e66f6b0aeddee7c30ca4))

# [0.1.0](https://github.com/ttoss/soat/compare/v0.0.0-alpha.2...v0.1.0) (2026-04-20)

### Bug Fixes

* docs labels ([db6d6b6](https://github.com/ttoss/soat/commit/db6d6b654e3d6af326ec5cd2885ffc8e0bc1f8a6))
* docs layout ([a73ad39](https://github.com/ttoss/soat/commit/a73ad39f31dcc3a43761be1c0f5133743e2703f3))
* respect configured HTTP method for agent http tool execution ([#14](https://github.com/ttoss/soat/issues/14)) ([4a3526e](https://github.com/ttoss/soat/commit/4a3526ea4cdcbe6181919f7287f6ce740d9e70d7))

### Features

* agents ([#9](https://github.com/ttoss/soat/issues/9)) ([cf91736](https://github.com/ttoss/soat/commit/cf917369ea4a58a62e5b866876a36e56fc0fdb0e))
* **agents:** support path parameters in HTTP tool execute.url ([#16](https://github.com/ttoss/soat/issues/16)) ([d3431d8](https://github.com/ttoss/soat/commit/d3431d8b3e296fa2c7ae1b01973040bd1d67b8a8))
* chats ([#6](https://github.com/ttoss/soat/issues/6)) ([6143723](https://github.com/ttoss/soat/commit/61437232b9ab1dd2a72ba21b8608ca10c6ceaf2b))
* create sdk ([#17](https://github.com/ttoss/soat/issues/17)) ([03f2aa7](https://github.com/ttoss/soat/commit/03f2aa7c27eed31a6969826c61d4ffcf3110b3af))
* documents api first implementation ([a5b172f](https://github.com/ttoss/soat/commit/a5b172fe1e8c535a3c79799307ebe6de7860b5a5))

# 0.0.0-alpha.2 (2026-01-06)

### Bug Fixes

* add version ([de8fab4](https://github.com/ttoss/soat/commit/de8fab4e0d51ba0e06e0b29f9b26ea8d147d92a6))

### Features

* docs first version ([e8d93de](https://github.com/ttoss/soat/commit/e8d93de4875fde001680ea7321bbe315f2987cc0))
