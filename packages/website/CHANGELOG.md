# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.35.0](https://github.com/ttoss/soat/compare/v0.34.0...v0.35.0) (2026-09-02)

### Features

* **website:** redesign the homepage around what SOAT is ([#1186](https://github.com/ttoss/soat/issues/1186)) ([266ce1a](https://github.com/ttoss/soat/commit/266ce1aae5be9a96edb37f9dcd51b835840a1dc2))

# [0.34.0](https://github.com/ttoss/soat/compare/v0.33.1...v0.34.0) (2026-09-01)

* feat(server)!: tell a resource-type handler which project, on every request (#1183) ([90a44f5](https://github.com/ttoss/soat/commit/90a44f5faee9581583850ecccc88a38e1bb6c974)), closes [#1183](https://github.com/ttoss/soat/issues/1183) [#1078](https://github.com/ttoss/soat/issues/1078)
* feat(server)!: refuse an unenforceable cost cap, and give a project its own chain budget (#1176) ([bd853d8](https://github.com/ttoss/soat/commit/bd853d8a0757e68871ce018accbf759130feb521)), closes [#1176](https://github.com/ttoss/soat/issues/1176) [#1164](https://github.com/ttoss/soat/issues/1164) [#811](https://github.com/ttoss/soat/issues/811) [#1167](https://github.com/ttoss/soat/issues/1167)
* feat(server)!: run a resumed turn under the agent's tool_choice, and bound it (#1174), closes [#1174](https://github.com/ttoss/soat/issues/1174) [#1170](https://github.com/ttoss/soat/issues/1170)
* feat(server)!: require a stop condition when tool_choice forces a tool (#1170) ([ed05e35](https://github.com/ttoss/soat/commit/ed05e356228370e31531c6db3d6a39bbdb3e7119)), closes [#1170](https://github.com/ttoss/soat/issues/1170)

### Bug Fixes

* **server:** enforce a formation property's declared enum ([#1166](https://github.com/ttoss/soat/issues/1166)) ([37c3dfb](https://github.com/ttoss/soat/commit/37c3dfb8c1f2c0247504b50bef020470410af296))
* **server:** let a continuation conclude instead of re-entering the forced-tool loop ([#1163](https://github.com/ttoss/soat/issues/1163)) ([3a6a745](https://github.com/ttoss/soat/commit/3a6a745574c33ba8871f74897ea1c24b63b310f6)), closes [#1161](https://github.com/ttoss/soat/issues/1161)
* **server:** terminate an unattended expiry, and make stop_conditions actually stop the loop ([#1167](https://github.com/ttoss/soat/issues/1167)) ([e2f1c3b](https://github.com/ttoss/soat/commit/e2f1c3bd0757b87dd35de03766b9a3585579f78e)), closes [#811](https://github.com/ttoss/soat/issues/811)

### Features

* **server:** bound continuation chains and name step exhaustion ([#1161](https://github.com/ttoss/soat/issues/1161)) ([08ac51d](https://github.com/ttoss/soat/commit/08ac51d31a9887b63a9166f7045dfbedfbe59164))
* **server:** carry tool_context on direct tool calls, and bound what a child run inherits ([#1178](https://github.com/ttoss/soat/issues/1178)) ([1a0a17f](https://github.com/ttoss/soat/commit/1a0a17f4fa5a64013c7adb2596e0f76228211740)), closes [#1148](https://github.com/ttoss/soat/issues/1148) [#1148](https://github.com/ttoss/soat/issues/1148) [850/#851](https://github.com/ttoss/soat/issues/851) [#1148](https://github.com/ttoss/soat/issues/1148) [#1151](https://github.com/ttoss/soat/issues/1151) [#1153](https://github.com/ttoss/soat/issues/1153)
* **server:** key the continuation budget on an identity nothing else rewrites ([#1162](https://github.com/ttoss/soat/issues/1162)) ([5aad198](https://github.com/ttoss/soat/commit/5aad1982fcb0ce8ae43b767410bd6c978feef596))
* **server:** let an eval run carry a tool_context ([#1182](https://github.com/ttoss/soat/issues/1182)) ([fed3396](https://github.com/ttoss/soat/commit/fed33962f0fd1b58b5f946a3ceadaa11bafe2f33)), closes [#1150](https://github.com/ttoss/soat/issues/1150)
* **server:** make the continuation chain a record, and let an agent bound it ([#1168](https://github.com/ttoss/soat/issues/1168)) ([611a67c](https://github.com/ttoss/soat/commit/611a67c342662102420395ff76fc3572bd969d46)), closes [#1161](https://github.com/ttoss/soat/issues/1161) [#1165](https://github.com/ttoss/soat/issues/1165) [#1165](https://github.com/ttoss/soat/issues/1165) [#1161](https://github.com/ttoss/soat/issues/1161)

### BREAKING CHANGES

* `FormationModule`'s `update`, `delete`, `read` and
  `getAttributes` now require `projectId`, as does `performResourceDeletions`
  (which also takes an object argument) and `resolveFormationOutputs`. A
  registered type's handler now receives `project_id` on every request
  except `validate`; a handler that ignores it is unaffected.
* an `enforce`-mode `cost_usd` quota now refuses a generation
  with `409 QUOTA_UNENFORCEABLE` when the current window holds at least 3 metered
  events and none of them are priced, where it previously allowed the generation
  and only filed a `quota_unpriced` exception. Configure the price book for the
  models in use, or set `on_unpriced: "allow"` on the quota to accept
  unmeasurable spend explicitly (`monitor` mode also never blocks).
* an `enforce`-mode `cost_usd` quota now refuses a generation
  with `409 QUOTA_UNENFORCEABLE` when the current window metered usage but priced
  none of it, where it previously allowed the generation and only filed a
  `quota_unpriced` exception. Configure the price book for the models in use, or
  set the quota to `monitor` mode to keep the old behavior.
* an agent whose `tool_choice` forces a tool now forces the
  resumed turn too, and a resumption spends what is left of `max_steps` rather
  than a fresh budget. An agent that forces a client tool by name pauses again
  after each submit until the turn ends on its step budget; move the force into
  `step_rules` to force only the first call.
* creating or updating an agent with `tool_choice: "required"` (or
  a named tool) now requires a `hasToolCall` stop condition. Stored agents keep
  running — the chain budget is what bounds them — but are refused on their next
  write until they declare an exit, a version restore included, since restore
  re-validates the config it writes back.

## [0.33.1](https://github.com/ttoss/soat/compare/v0.33.0...v0.33.1) (2026-08-29)

**Note:** Version bump only for package @soat/website

# [0.33.0](https://github.com/ttoss/soat/compare/v0.32.0...v0.33.0) (2026-08-26)

### Features

* **server:** make a run's usage cover what it delegated, and attribute nested runs ([#1144](https://github.com/ttoss/soat/issues/1144)) ([9266a0c](https://github.com/ttoss/soat/commit/9266a0c865df6ad63b4ee3b158911960097981b7)), closes [#1135](https://github.com/ttoss/soat/issues/1135) [#1135](https://github.com/ttoss/soat/issues/1135)
* **server:** resolve {{context:}} in preset_parameters and carry a run's context to its tool nodes ([#1148](https://github.com/ttoss/soat/issues/1148)) ([1e920ab](https://github.com/ttoss/soat/commit/1e920abd3a9e015c4bd4361755dea38d0f23d641)), closes [TriangulosTecnologia/naturali.ai#345](https://github.com/TriangulosTecnologia/naturali.ai/issues/345) [TriangulosTecnologia/naturali.ai#345](https://github.com/TriangulosTecnologia/naturali.ai/issues/345)

### BREAKING CHANGES

* **server:** `usage` on an orchestration run now includes every nested run
  it started, at any depth; it previously covered the run's own nodes only. The
  previous meaning is available as `usage_own`, which is equal to `usage` for a
  run with no children. Callers summing `usage` over a list of runs must pass
  `nested=false` to avoid counting a child twice.

# [0.32.0](https://github.com/ttoss/soat/compare/v0.31.0...v0.32.0) (2026-08-26)

### Bug Fixes

* **server:** make preset_parameters a pin the caller cannot override ([#1141](https://github.com/ttoss/soat/issues/1141)) ([e345c77](https://github.com/ttoss/soat/commit/e345c7771a492b649ddff577ed248b57d0a41698)), closes [#965](https://github.com/ttoss/soat/issues/965)
* **server:** meter a run's tokens per attempt, and meter the tokens a failed turn already spent ([#1140](https://github.com/ttoss/soat/issues/1140)) ([15a699a](https://github.com/ttoss/soat/commit/15a699a6e3ef21f4e1a2f2edfcf04c42bb6bf083)), closes [#1138](https://github.com/ttoss/soat/issues/1138)

### Features

* **server:** let a registered resource type declare write-only properties ([#1142](https://github.com/ttoss/soat/issues/1142)) ([feb3956](https://github.com/ttoss/soat/commit/feb3956c5b8019a847c6f45153f43addb33273eb)), closes [#1078](https://github.com/ttoss/soat/issues/1078) [#1078](https://github.com/ttoss/soat/issues/1078)

# [0.31.0](https://github.com/ttoss/soat/compare/v0.30.1...v0.31.0) (2026-08-25)

### Bug Fixes

* **server:** retry the writes that get an event into the delivery outbox ([#1132](https://github.com/ttoss/soat/issues/1132)) ([4be8c96](https://github.com/ttoss/soat/commit/4be8c96c69f9ece8603c62749ed16cf62395f617)), closes [#1052](https://github.com/ttoss/soat/issues/1052) [#1130](https://github.com/ttoss/soat/issues/1130)

### Features

* **server:** let a caller label a run, an eval run and a task with metadata ([#1129](https://github.com/ttoss/soat/issues/1129)) ([3fa7b88](https://github.com/ttoss/soat/commit/3fa7b88e9a2e9548de476c486b042227057ac18f)), closes [TriangulosTecnologia/naturali.ai#342](https://github.com/TriangulosTecnologia/naturali.ai/issues/342) [#342](https://github.com/ttoss/soat/issues/342)
* **server:** let a deployment register custom formation resource types ([#1137](https://github.com/ttoss/soat/issues/1137)) ([197d5fd](https://github.com/ttoss/soat/commit/197d5fd3e3b72a7cd458d38d8d969fcbd9136fc5)), closes [#1078](https://github.com/ttoss/soat/issues/1078) [#1130](https://github.com/ttoss/soat/issues/1130)
* **server:** name the node behind every usage receipt line ([#1136](https://github.com/ttoss/soat/issues/1136)) ([9ec58d4](https://github.com/ttoss/soat/commit/9ec58d4e7efc94a9f8ffc9693b0e43e0282cba48)), closes [#1134](https://github.com/ttoss/soat/issues/1134)
* **triggers:** add an event trigger type ([#1133](https://github.com/ttoss/soat/issues/1133)) ([5abf1ab](https://github.com/ttoss/soat/commit/5abf1abaf192953cea3e98705dceb8af8b372096))

## [0.30.1](https://github.com/ttoss/soat/compare/v0.30.0...v0.30.1) (2026-08-25)

### Bug Fixes

* **server:** make the error envelope's hint and docs_url relayable ([#1127](https://github.com/ttoss/soat/issues/1127)) ([f043991](https://github.com/ttoss/soat/commit/f04399114e2b190569cbab35afd2c1e368b24896)), closes [ttoss/soat#1126](https://github.com/ttoss/soat/issues/1126) [#1126](https://github.com/ttoss/soat/issues/1126)

# [0.30.0](https://github.com/ttoss/soat/compare/v0.29.5...v0.30.0) (2026-08-24)

### Features

* **server:** reach an agent node's generation from an orchestration run ([#1123](https://github.com/ttoss/soat/issues/1123)) ([a4121a2](https://github.com/ttoss/soat/commit/a4121a25f02e21776c493ceab25daa9d0f95c50f))
* **website:** show CLI commands instead of REST endpoints on homepage ([#1121](https://github.com/ttoss/soat/issues/1121)) ([7876780](https://github.com/ttoss/soat/commit/7876780d4c6d857ae756ef16480f534ce079bd69))

## [0.29.5](https://github.com/ttoss/soat/compare/v0.29.4...v0.29.5) (2026-08-24)

### Features

* **website:** publish the trust anchor, developer, and entity signals an agent-readiness audit reads ([#1118](https://github.com/ttoss/soat/issues/1118)) ([4b08b3a](https://github.com/ttoss/soat/commit/4b08b3ad94247a8a50e247f17cdc55f2091e0666))

## [0.29.4](https://github.com/ttoss/soat/compare/v0.29.3...v0.29.4) (2026-08-24)

### Features

* **website:** send Vary: Accept, and trim the negotiation comments ([#1116](https://github.com/ttoss/soat/issues/1116)) ([cb8d037](https://github.com/ttoss/soat/commit/cb8d037b685e429623b1e31c3621748d43afd356)), closes [ttoss/ttoss#1206](https://github.com/ttoss/ttoss/issues/1206) [#1111](https://github.com/ttoss/soat/issues/1111)

## [0.29.3](https://github.com/ttoss/soat/compare/v0.29.2...v0.29.3) (2026-08-24)

### Bug Fixes

* **tutorials:** size the LLM-bound poll budgets from a measurement ([#1113](https://github.com/ttoss/soat/issues/1113)) ([9131806](https://github.com/ttoss/soat/commit/913180682eea676fb4433fdf7ad4a7a9cc90fe56))
* **website:** use the array form so responseHeaders reaches the template ([#1114](https://github.com/ttoss/soat/issues/1114)) ([31ef600](https://github.com/ttoss/soat/commit/31ef60079dbdaba221c308c04d4e909536bdf93b)), closes [#1111](https://github.com/ttoss/soat/issues/1111)

## [0.29.2](https://github.com/ttoss/soat/compare/v0.29.1...v0.29.2) (2026-08-23)

### Bug Fixes

* **website:** finish Markdown negotiation — Vary: Accept, and the 404 page's wording ([#1108](https://github.com/ttoss/soat/issues/1108)) ([0ce8158](https://github.com/ttoss/soat/commit/0ce8158cd66748477c1988cfe92b1d0c45356358)), closes [#1106](https://github.com/ttoss/soat/issues/1106) [#1106](https://github.com/ttoss/soat/issues/1106) [#1111](https://github.com/ttoss/soat/issues/1111) [ttoss/ttoss#1205](https://github.com/ttoss/ttoss/issues/1205)

## [0.29.1](https://github.com/ttoss/soat/compare/v0.29.0...v0.29.1) (2026-08-23)

**Note:** Version bump only for package @soat/website

# [0.29.0](https://github.com/ttoss/soat/compare/v0.28.0...v0.29.0) (2026-08-23)

### Bug Fixes

* **website:** give folder-index docs a slash-less canonical URL ([#1103](https://github.com/ttoss/soat/issues/1103)) ([a17803a](https://github.com/ttoss/soat/commit/a17803aff5fbc81cd8965e278273224fa0c4c732))

### Features

* **brand:** describe SOAT the same way on every property it owns ([#1102](https://github.com/ttoss/soat/issues/1102)) ([2210234](https://github.com/ttoss/soat/commit/22102342f6a8129bc7e64b2d2f0f9e7d4ba41a97)), closes [#1099](https://github.com/ttoss/soat/issues/1099)
* default-deny tool egress to non-public destinations ([#1105](https://github.com/ttoss/soat/issues/1105)) ([030d203](https://github.com/ttoss/soat/commit/030d203ba6e792d383f6a93e3f267879bcefd576))
* **oauth:** describe the OAuth 2.1 endpoints in the OpenAPI specs ([#1100](https://github.com/ttoss/soat/issues/1100)) ([28f2085](https://github.com/ttoss/soat/commit/28f20859365902aa78c79173d53a1ff530a3c59f)), closes [#1099](https://github.com/ttoss/soat/issues/1099)
* **website:** negotiate Markdown on the page URL at the edge ([#1106](https://github.com/ttoss/soat/issues/1106)) ([b2bfa47](https://github.com/ttoss/soat/commit/b2bfa47883e35a8542d4ea68139a4398c5733346))
* **website:** tell agents when to use SOAT and what to do when a call fails ([#1098](https://github.com/ttoss/soat/issues/1098)) ([efc23cd](https://github.com/ttoss/soat/commit/efc23cdf8ac189a9b86137d2d8b2d2f5d3520928))

### BREAKING CHANGES

* an `http` or `mcp` tool whose target is not publicly routable
  now fails with `403 TOOL_EGRESS_BLOCKED` unless the destination is listed in
  the new `TOOL_EGRESS_ALLOWED_HOSTS` environment variable. Deployments whose
  tools call internal services must declare them; when the destination is SOAT's
  own API, prefer a `builtin` tool, which dispatches in-process under the
  caller's permissions instead of leaving the network. The production Docker
  image now runs as uid 1000 (`node`), so a bind-mounted files volume needs
  `chown 1000:1000` once.

# [0.28.0](https://github.com/ttoss/soat/compare/v0.27.0...v0.28.0) (2026-08-21)

### Bug Fixes

* **ai-providers:** list vertex models from the non-regional hosts ([#1094](https://github.com/ttoss/soat/issues/1094)) ([4c83d74](https://github.com/ttoss/soat/commit/4c83d7413103aa838b9ed95b530828e18df05a70)), closes [#1087](https://github.com/ttoss/soat/issues/1087) [#1080](https://github.com/ttoss/soat/issues/1080) [#1087](https://github.com/ttoss/soat/issues/1087)

### Features

* **website:** publish machine-readable surfaces for AI agents ([#1096](https://github.com/ttoss/soat/issues/1096)) ([daa57bb](https://github.com/ttoss/soat/commit/daa57bbca24e231f9afa5c77d708f31f14de53f6))

# [0.27.0](https://github.com/ttoss/soat/compare/v0.26.0...v0.27.0) (2026-08-20)

* feat!: rename the IAM resource-name prefix from soat: to srn: (#1092) ([115d155](https://github.com/ttoss/soat/commit/115d155deb0b64217faa2b7e07b94537ff2f3dd7)), closes [#1092](https://github.com/ttoss/soat/issues/1092)
* feat!: rename soat-branded author tokens to vendor-neutral names (#1091) ([538dbac](https://github.com/ttoss/soat/commit/538dbac6500d60792f01deaee036cb7048c3e9ef)), closes [#1091](https://github.com/ttoss/soat/issues/1091)

### Bug Fixes

* **ai-providers:** make the vertex model listing truthful ([#1090](https://github.com/ttoss/soat/issues/1090)) ([7602ed8](https://github.com/ttoss/soat/commit/7602ed86dcbc829eb86058f2c16bc105d73e8f1d)), closes [#1089](https://github.com/ttoss/soat/issues/1089)

### BREAKING CHANGES

* guardrail documents referencing `soat.*` and tools with
  `type: 'soat'` are rejected until the migration script has been run.
* policy documents using `soat:<project>:<type>:<id>` resource
  names are rejected, and stored ones stop matching, until the migration script
  has been run. Condition keys are unaffected.

# [0.26.0](https://github.com/ttoss/soat/compare/v0.25.1...v0.26.0) (2026-08-19)

### Bug Fixes

* **agents:** report provider failures on a streaming generation ([#1085](https://github.com/ttoss/soat/issues/1085)) ([0e80550](https://github.com/ttoss/soat/commit/0e80550d723d39a7787245828e67dd78c4a89c2e)), closes [#1081](https://github.com/ttoss/soat/issues/1081) [#1083](https://github.com/ttoss/soat/issues/1083) [#1083](https://github.com/ttoss/soat/issues/1083) [#1083](https://github.com/ttoss/soat/issues/1083) [#1084](https://github.com/ttoss/soat/issues/1084)
* **ai-providers,chats:** correct the vertex listing URL and map provider errors ([#1083](https://github.com/ttoss/soat/issues/1083)) ([00921ee](https://github.com/ttoss/soat/commit/00921ee87f3a84cf5211fbdf9c6d3373c9c63563)), closes [#1080](https://github.com/ttoss/soat/issues/1080) [#1081](https://github.com/ttoss/soat/issues/1081) [179/#180](https://github.com/ttoss/soat/issues/180) [#1080](https://github.com/ttoss/soat/issues/1080) [#1081](https://github.com/ttoss/soat/issues/1081)
* **projects:** count and cascade every project-scoped model on delete ([#1082](https://github.com/ttoss/soat/issues/1082)) ([f8f7d7b](https://github.com/ttoss/soat/commit/f8f7d7bcc9f0416d2fab5fd3721dc4fddf10a7d4)), closes [#1079](https://github.com/ttoss/soat/issues/1079) [#834](https://github.com/ttoss/soat/issues/834) [#1079](https://github.com/ttoss/soat/issues/1079)

### Features

* **evaluations:** add embedding_similarity scorer for cosine similarity grading ([#1077](https://github.com/ttoss/soat/issues/1077)) ([7314ade](https://github.com/ttoss/soat/commit/7314ade2e514ee192c18491aa81cc4644f830c83))

## [0.25.1](https://github.com/ttoss/soat/compare/v0.25.0...v0.25.1) (2026-08-17)

**Note:** Version bump only for package @soat/website

# [0.25.0](https://github.com/ttoss/soat/compare/v0.24.0...v0.25.0) (2026-08-17)

### Features

* **evaluations:** custom tool scorers + Engine & Algorithms pattern docs ([#1068](https://github.com/ttoss/soat/issues/1068)) ([f7375cd](https://github.com/ttoss/soat/commit/f7375cd5a5fb85ab38a018ec4b6e327159ad43ee))
* **server:** filter documents by path prefix ([#1059](https://github.com/ttoss/soat/issues/1059)) ([24c3c12](https://github.com/ttoss/soat/commit/24c3c121fca4dda24cdc25b86391cc746659d8f4))
* **website:** add the Claude Developer Platform to the benchmark ([#1067](https://github.com/ttoss/soat/issues/1067)) ([a7f5aaf](https://github.com/ttoss/soat/commit/a7f5aaf7f814e093f5167c7b0fd8a8cb6549f31f))
* **website:** enable mermaid diagrams in docs ([#1065](https://github.com/ttoss/soat/issues/1065)) ([4680bed](https://github.com/ttoss/soat/commit/4680bedae8277ecde48d63821db4f0694a7cf7c8))
* **website:** strengthen AI/search grounding signals for docs ([#1058](https://github.com/ttoss/soat/issues/1058)) ([5a727ba](https://github.com/ttoss/soat/commit/5a727ba7136d16b4b75cf76d1f9d7eb933e7052b))

# [0.24.0](https://github.com/ttoss/soat/compare/v0.23.0...v0.24.0) (2026-08-16)

### Bug Fixes

* **ai-providers:** list models with the record's own credentials ([#1048](https://github.com/ttoss/soat/issues/1048)) ([850e4d6](https://github.com/ttoss/soat/commit/850e4d676abe4b6ef1330265b26e3325390791ab)), closes [#1040](https://github.com/ttoss/soat/issues/1040)
* **api-keys:** confine key management to a scoped credential's project ([#1038](https://github.com/ttoss/soat/issues/1038)) ([#1045](https://github.com/ttoss/soat/issues/1045)) ([74c181e](https://github.com/ttoss/soat/commit/74c181e03310a8dd9c08e85136d02045d2bd6bdb)), closes [#1036](https://github.com/ttoss/soat/issues/1036)
* **formations:** a failed deploy explains itself on the response ([#1028](https://github.com/ttoss/soat/issues/1028)) ([#1031](https://github.com/ttoss/soat/issues/1031)) ([50e20a2](https://github.com/ttoss/soat/commit/50e20a2773d790f513068053f85fc131372f4f85))
* **server:** deny writes with 403, not 404, on an empty project scope ([#1033](https://github.com/ttoss/soat/issues/1033)) ([5eae41d](https://github.com/ttoss/soat/commit/5eae41d7f4d25a8b44d0475279d15245393c52e1)), closes [#1029](https://github.com/ttoss/soat/issues/1029)
* **tasks:** reconcile dispatches orphaned by a restart ([#1051](https://github.com/ttoss/soat/issues/1051)) ([8bebcba](https://github.com/ttoss/soat/commit/8bebcba8e8fcb5bebca09ed869f0beb5c1f3d53e)), closes [#855](https://github.com/ttoss/soat/issues/855)
* **tests:** pin quota enforcement sequences to a non-rolling window ([#1049](https://github.com/ttoss/soat/issues/1049)) ([#1054](https://github.com/ttoss/soat/issues/1054)) ([c054c31](https://github.com/ttoss/soat/commit/c054c31bf17764b1c8d5adf3a2a9487f835fc933))
* **traces:** keep every generation's steps when a trace_id is reused ([#1027](https://github.com/ttoss/soat/issues/1027)) ([523d9f9](https://github.com/ttoss/soat/commit/523d9f99654e4f25ed0bcd81ff1d8329fd6e2028)), closes [#1024](https://github.com/ttoss/soat/issues/1024) [#1024](https://github.com/ttoss/soat/issues/1024) [pre-#1024](https://github.com/pre-/issues/1024)

### Features

* **documents:** echo the source file content_type and emit ingestion lifecycle events ([#1050](https://github.com/ttoss/soat/issues/1050)) ([befb2c7](https://github.com/ttoss/soat/commit/befb2c74eee573d1019a1a469c7c8d69eb14c8c9)), closes [#1041](https://github.com/ttoss/soat/issues/1041)
* **eventBus:** type the event envelope so a wrong event name stops compiling ([#1015](https://github.com/ttoss/soat/issues/1015)) ([48cbe9d](https://github.com/ttoss/soat/commit/48cbe9dbb34ae387598af4cf854d25138807d8b3)), closes [#1004](https://github.com/ttoss/soat/issues/1004) [#903](https://github.com/ttoss/soat/issues/903)
* **generations:** read a turn back as a transcript ([#1021](https://github.com/ttoss/soat/issues/1021)) ([#1026](https://github.com/ttoss/soat/issues/1026)) ([640b532](https://github.com/ttoss/soat/commit/640b5328ed3b222521408cebf40894c54e4f1ecc)), closes [#1012](https://github.com/ttoss/soat/issues/1012) [#1012](https://github.com/ttoss/soat/issues/1012)
* **knowledge:** add score as the ranking field; document the injection threat model (RC-3, RC-4) ([#1032](https://github.com/ttoss/soat/issues/1032)) ([c9d90de](https://github.com/ttoss/soat/commit/c9d90dec70995e4da117f878f55b5c98bf284059))
* **knowledge:** carry entry id and page in injected source tags (RC-5) ([#1030](https://github.com/ttoss/soat/issues/1030)) ([92e24b0](https://github.com/ttoss/soat/commit/92e24b09e385a42ff61b2ef23e6398c016e881e0))
* **memories:** entry provenance and temporal invalidation schema (RC-1, RC-2) ([#1025](https://github.com/ttoss/soat/issues/1025)) ([561efeb](https://github.com/ttoss/soat/commit/561efeb53d68e600f942ffbbbc5522b871be2b0a))
* **sessions:** fork a session from any point in its history ([#1023](https://github.com/ttoss/soat/issues/1023)) ([#1035](https://github.com/ttoss/soat/issues/1035)) ([cf234bb](https://github.com/ttoss/soat/commit/cf234bb87628ea308a318c82d5ab1d9fc93e40f2))
* **webhooks:** durable delivery outbox, redelivery, and timestamped signature ([#1052](https://github.com/ttoss/soat/issues/1052)) ([c7ce377](https://github.com/ttoss/soat/commit/c7ce377fd11cc383a51677c3c9b56342d3208ef0)), closes [#1037](https://github.com/ttoss/soat/issues/1037)
* **workflows:** add a `tool` on_enter dispatch kind ([#1053](https://github.com/ttoss/soat/issues/1053)) ([42f943f](https://github.com/ttoss/soat/commit/42f943f2167ca8dc2157fbb2d50b02821fbaaef8)), closes [#792](https://github.com/ttoss/soat/issues/792) [#1039](https://github.com/ttoss/soat/issues/1039)

# [0.23.0](https://github.com/ttoss/soat/compare/v0.22.1...v0.23.0) (2026-08-14)

* feat!: one rule for system content — never a message, on any surface (#995) ([da80f03](https://github.com/ttoss/soat/commit/da80f03c176927e509289ba9db18b808d45ba783)), closes [#995](https://github.com/ttoss/soat/issues/995)

### Bug Fixes

* close three silent-failure gaps found QA-ing the module surface ([#994](https://github.com/ttoss/soat/issues/994)) ([a2ed76a](https://github.com/ttoss/soat/commit/a2ed76aa88653f4822407c86399a5e830142eb74)), closes [#990](https://github.com/ttoss/soat/issues/990) [#991](https://github.com/ttoss/soat/issues/991) [#992](https://github.com/ttoss/soat/issues/992) [#991](https://github.com/ttoss/soat/issues/991) [#991](https://github.com/ttoss/soat/issues/991)
* enforce chats:CreateChatCompletion on stateless completions ([#1000](https://github.com/ttoss/soat/issues/1000)) ([b037b40](https://github.com/ttoss/soat/commit/b037b404a0d0a35969eab6e51156083ecdeb709c)), closes [#998](https://github.com/ttoss/soat/issues/998) [#996](https://github.com/ttoss/soat/issues/996) [#801](https://github.com/ttoss/soat/issues/801)
* **evaluations:** make eval failures, spend, and teardown legible ([#987](https://github.com/ttoss/soat/issues/987)) ([4c6d2f9](https://github.com/ttoss/soat/commit/4c6d2f9af8bbecf52d99fd3e4f2a8bb66968e818)), closes [#982](https://github.com/ttoss/soat/issues/982) [#983](https://github.com/ttoss/soat/issues/983) [#984](https://github.com/ttoss/soat/issues/984) [#985](https://github.com/ttoss/soat/issues/985)
* **server:** make the webhook delivery envelope snake_case ([#986](https://github.com/ttoss/soat/issues/986)) ([42a4546](https://github.com/ttoss/soat/commit/42a4546e587f341bfeeca1aed86e162bc97e87ef))
* unrecoverable formation teardown, and the doc-example drift the CLI-only check missed ([#1013](https://github.com/ttoss/soat/issues/1013)) ([5920c94](https://github.com/ttoss/soat/commit/5920c948ca2e8cafe334e3d729c9ae5a3340eeb6)), closes [#985](https://github.com/ttoss/soat/issues/985) [#992](https://github.com/ttoss/soat/issues/992)
* unwind resources a failed formation apply already created ([#999](https://github.com/ttoss/soat/issues/999)) ([#1009](https://github.com/ttoss/soat/issues/1009)) ([840d5e2](https://github.com/ttoss/soat/commit/840d5e29985a0927caeb03431242ba70ee593c8d))

### Features

* **evaluations:** curate dataset items from completed generations ([#1012](https://github.com/ttoss/soat/issues/1012)) ([8faac15](https://github.com/ttoss/soat/commit/8faac1507fb50f6d7f8945e85c930c6277e2ae7e)), closes [#1003](https://github.com/ttoss/soat/issues/1003)
* fold chat-scoped completions into POST /chat/completions ([#996](https://github.com/ttoss/soat/issues/996)) ([21efa25](https://github.com/ttoss/soat/commit/21efa251abe5f571235ab596ec4b077096968dec))

### BREAKING CHANGES

* `POST /api/v1/chats/{chat_id}/completions` is removed.
  Callers pass `chat_id` in the body of `POST /api/v1/chat/completions`
  instead. The SDK's `createChatCompletionForChat`, the CLI's
  `create-chat-completion-for-chat`, and the derived MCP tool are gone; the
  `chats:CreateChatCompletionForChat` permission action no longer exists and
  policies granting it must grant `chats:CreateChatCompletion`.
* `system_message` is gone from the wire — the Chat
  resource, `POST /chats` (`--instructions` on the CLI), and both
  completion request bodies now spell it `instructions`. `POST /chats`
  rejects the old name via strictFields; the completion endpoints are
  strict-fields-exempt for LLM passthrough, so an old `system_message`
  there is ignored rather than refused — update callers.
* the chat completion endpoints and the conversation
  add-message endpoint no longer accept role:"system" in caller-supplied
  messages; send system content in the completion `system_message` field
  (or the agent's `instructions`) instead. The 400 names the fix.
* **server:** webhook delivery payloads now use `project_id`, `resource_type`
  and `resource_id` instead of `projectId`, `resourceType` and `resourceId`.
  Receivers reading those three envelope fields must be updated; `event`, `data`
  and `timestamp` are unchanged.

## [0.22.1](https://github.com/ttoss/soat/compare/v0.22.0...v0.22.1) (2026-08-13)

**Note:** Version bump only for package @soat/website

# [0.22.0](https://github.com/ttoss/soat/compare/v0.21.0...v0.22.0) (2026-08-13)

### Bug Fixes

* **server:** OpenAPI spec drift burn-down + full-surface contract enforcement ([#977](https://github.com/ttoss/soat/issues/977)) ([6b429ab](https://github.com/ttoss/soat/commit/6b429ab24a924826f431f9135ef3ce57a04739c0)), closes [#661](https://github.com/ttoss/soat/issues/661)

### Features

* **agents:** announce a failed generation on the event bus ([#978](https://github.com/ttoss/soat/issues/978)) ([6fdafd1](https://github.com/ttoss/soat/commit/6fdafd1775161a4e21932d8b3f6ab9d75a480ecc))

# [0.21.0](https://github.com/ttoss/soat/compare/v0.20.5...v0.21.0) (2026-08-13)

* feat(discussions)!: remove the discussions module (#973) ([c2d9b02](https://github.com/ttoss/soat/commit/c2d9b02c9c9b9476359340ccb7423f4374bf7db4)), closes [#973](https://github.com/ttoss/soat/issues/973)
* refactor(evaluations,discussions)!: qualify the run path parameter (#970) ([5c8c00e](https://github.com/ttoss/soat/commit/5c8c00e9c87f7d7166dec2b2f9c837454d3bb368)), closes [#970](https://github.com/ttoss/soat/issues/970) [#969](https://github.com/ttoss/soat/issues/969) [#969](https://github.com/ttoss/soat/issues/969)
* feat(api)!: unify the sync/async execution toggle as `wait` across all endpoints (#965) ([d10c1e5](https://github.com/ttoss/soat/commit/d10c1e57e5a95d3bce1c40464589f986ae81d918)), closes [#965](https://github.com/ttoss/soat/issues/965) [#async-generation](https://github.com/ttoss/soat/issues/async-generation)

### Features

* **agents:** gate canary promotion on a passing eval run (Phase 3) ([#968](https://github.com/ttoss/soat/issues/968)) ([30df86f](https://github.com/ttoss/soat/commit/30df86f97e9b030d9fee2cef71f2e530defb28ba))
* **evaluations:** datasets, evals, and synchronous scored runs (Phase 1) ([#964](https://github.com/ttoss/soat/issues/964)) ([0c25434](https://github.com/ttoss/soat/commit/0c25434b61464c1ad6b734a60f1b9f5d66fde6d3))
* **evaluations:** LLM judge, queued runs, baseline deltas, and lifecycle webhooks (Phase 2) ([#966](https://github.com/ttoss/soat/issues/966)) ([7b5c06b](https://github.com/ttoss/soat/commit/7b5c06b75ecf4555705f290435a54a946d9edee6))
* **evaluations:** scheduled eval runs and evaluation formation resources (Phase 3) ([#969](https://github.com/ttoss/soat/issues/969)) ([3a2a18e](https://github.com/ttoss/soat/commit/3a2a18e3cc8f5202ebf2c0958f8faa1f3819a620))

### BREAKING CHANGES

* POST /agents/{agent_id}/generate and
  POST /conversations/{conversation_id}/generate now run in the background
  and return 202 by default. Callers that need the result inline — which
  includes every client-tool (requires_action) flow — must pass ?wait=true.
* the ?async= query parameter is removed from
  POST /documents/ingest, POST /documents/{document_id}/ingest, and
  POST /sessions/{session_id}/generate; use wait=true to block.
  POST /sessions/{session_id}/generate now returns 202 and runs in the
  background by default; callers that need the reply in the response must
  pass ?wait=true. An unrecognized ?async= parameter is silently ignored.
* the /api/v1/discussions endpoints, their MCP tools and
  SDK/CLI operations, the `discussion` formation resource type, and the
  `discussions:*` permissions are removed. The 409 AI_PROVIDER_HAS_DEPENDENTS
  meta no longer carries discussionCount, discussionIds, or
  discussionParticipantCount. search-knowledge no longer excludes documents
  under /discussions/ by default, so legacy transcripts in an existing
  install become ordinary, searchable project documents within their own
  project until deleted.
* the `run_id` parameter of `get-eval-run`,
  `list-eval-results`, `cancel-eval-run` and `get-discussion-run` is renamed
  to `eval_run_id` / `discussion_run_id`. Callers pass `--eval-run-id` /
  `--discussion-run-id` on the CLI, and the matching key in the SDK and MCP
  tool arguments. Request URLs are unaffected.

## [0.20.5](https://github.com/ttoss/soat/compare/v0.20.4...v0.20.5) (2026-08-12)

### Features

* **server:** ask an AI provider which models it can run ([#962](https://github.com/ttoss/soat/issues/962)) ([eec9b86](https://github.com/ttoss/soat/commit/eec9b867135a7d83a164e79654622c2c054692ee))

## [0.20.4](https://github.com/ttoss/soat/compare/v0.20.3...v0.20.4) (2026-08-12)

### Bug Fixes

* **server:** sum usage quantities as exact decimals ([#958](https://github.com/ttoss/soat/issues/958)) ([1075a04](https://github.com/ttoss/soat/commit/1075a04555a773425b8f53fc36af0534575f6a1a)), closes [#953](https://github.com/ttoss/soat/issues/953)

### Features

* **server:** source AWS credentials from the provider chain for vertex ([#959](https://github.com/ttoss/soat/issues/959)) ([b6338f9](https://github.com/ttoss/soat/commit/b6338f939bc6dbc1cd740e0449b8a159ba931cea))

## [0.20.3](https://github.com/ttoss/soat/compare/v0.20.2...v0.20.3) (2026-08-11)

### Bug Fixes

* **server:** inherit exception severity on activity entries, document feed retention ([#943](https://github.com/ttoss/soat/issues/943)) ([9cdf28e](https://github.com/ttoss/soat/commit/9cdf28e636b4f99c6c063ab5d0120aa4011a5478)), closes [high-volume](https://github.com/hi/issues/volume)
* **website:** use MDX directive syntax for titled admonitions ([#942](https://github.com/ttoss/soat/issues/942)) ([ba5e251](https://github.com/ttoss/soat/commit/ba5e2514c363d721328ed8ebcaf79e5ad6c8a286))

### Features

* **server:** add a per-tool context_keys allowlist ([#949](https://github.com/ttoss/soat/issues/949)) ([fdfc095](https://github.com/ttoss/soat/commit/fdfc0953170120bff6ac2594edb4f523b376d167))
* **server:** carry tool_context on orchestration runs ([#946](https://github.com/ttoss/soat/issues/946)) ([8a38e95](https://github.com/ttoss/soat/commit/8a38e95eec5bc8295cb14887e92f4f48dbfb4bc6)), closes [#945](https://github.com/ttoss/soat/issues/945)
* **server:** carry tool_context through task automation dispatches ([#951](https://github.com/ttoss/soat/issues/951)) ([3c4f6a9](https://github.com/ttoss/soat/commit/3c4f6a994116f90ee245ef80fcac0a6198f196e7)), closes [850/#851](https://github.com/ttoss/soat/issues/851) [#950](https://github.com/ttoss/soat/issues/950) [786/#887](https://github.com/ttoss/soat/issues/887)
* **server:** make the tool-context header prefix configurable ([#947](https://github.com/ttoss/soat/issues/947)) ([00e3bee](https://github.com/ttoss/soat/commit/00e3bee875da87217f971b1ed575c3e3494da46d)), closes [850/#851](https://github.com/ttoss/soat/issues/851) [#945](https://github.com/ttoss/soat/issues/945)
* **server:** report measured quantities in the usage rollup ([#953](https://github.com/ttoss/soat/issues/953)) ([f0c8efa](https://github.com/ttoss/soat/commit/f0c8efa3142d9cbd951fe41551e23c35a5976fde)), closes [#952](https://github.com/ttoss/soat/issues/952)
* **server:** resolve {{context:<key>}} tokens in tool headers ([#948](https://github.com/ttoss/soat/issues/948)) ([78929d2](https://github.com/ttoss/soat/commit/78929d24af3e659a548bea788ac4046a00ee2b7d)), closes [#945](https://github.com/ttoss/soat/issues/945) [850/#851](https://github.com/ttoss/soat/issues/851)

## [0.20.2](https://github.com/ttoss/soat/compare/v0.20.1...v0.20.2) (2026-08-10)

**Note:** Version bump only for package @soat/website

## [0.20.1](https://github.com/ttoss/soat/compare/v0.20.0...v0.20.1) (2026-08-09)

### Bug Fixes

* **server:** attribute a key-started run to the API key, not its owner ([#917](https://github.com/ttoss/soat/issues/917)) ([1b7127f](https://github.com/ttoss/soat/commit/1b7127f42683d3f9797123d4fcdf773ac1150bfa)), closes [#801](https://github.com/ttoss/soat/issues/801) [#887](https://github.com/ttoss/soat/issues/887) [#889](https://github.com/ttoss/soat/issues/889)
* **server:** give an approval continuation the identity of the chain that started it ([#918](https://github.com/ttoss/soat/issues/918)) ([ba08d48](https://github.com/ttoss/soat/commit/ba08d48839d763d46cb82ece05d9436a848cfc5c)), closes [#894](https://github.com/ttoss/soat/issues/894) [#879](https://github.com/ttoss/soat/issues/879) [#884](https://github.com/ttoss/soat/issues/884) [#894](https://github.com/ttoss/soat/issues/894) [#894](https://github.com/ttoss/soat/issues/894)
* **server:** send a soat action's query string, so list actions scope ([#929](https://github.com/ttoss/soat/issues/929)) ([db870bd](https://github.com/ttoss/soat/commit/db870bd11e5e7f463b3228f00d3fcbae38d48d3d)), closes [#924](https://github.com/ttoss/soat/issues/924)
* **server:** the eight duplication-caused defects from [#916](https://github.com/ttoss/soat/issues/916) ([#919](https://github.com/ttoss/soat/issues/919)) ([c630220](https://github.com/ttoss/soat/commit/c6302202872e91dfe9814f3b474a6d05ca02c96b)), closes [#900](https://github.com/ttoss/soat/issues/900) [#901](https://github.com/ttoss/soat/issues/901) [#902](https://github.com/ttoss/soat/issues/902) [#903](https://github.com/ttoss/soat/issues/903) [#904](https://github.com/ttoss/soat/issues/904) [#905](https://github.com/ttoss/soat/issues/905) [#906](https://github.com/ttoss/soat/issues/906) [#907](https://github.com/ttoss/soat/issues/907) [#900](https://github.com/ttoss/soat/issues/900) [#901](https://github.com/ttoss/soat/issues/901) [#902](https://github.com/ttoss/soat/issues/902) [#903](https://github.com/ttoss/soat/issues/903) [#904](https://github.com/ttoss/soat/issues/904) [#905](https://github.com/ttoss/soat/issues/905) [#906](https://github.com/ttoss/soat/issues/906) [#907](https://github.com/ttoss/soat/issues/907)
* **workflows:** bound the composed workflow↔dispatch cycle ([#899](https://github.com/ttoss/soat/issues/899)) ([ea73a54](https://github.com/ttoss/soat/commit/ea73a54cdc5a02acd822c34fb8b757bfcced29a2)), closes [#885](https://github.com/ttoss/soat/issues/885)

### Features

* **server:** dispatch MCP tool calls in-process instead of over the loopback ([#930](https://github.com/ttoss/soat/issues/930)) ([65de605](https://github.com/ttoss/soat/commit/65de605f96a5a10ecb2084db179cf7cdd765dd50))
* **server:** dispatch soat tool actions in-process instead of over the loopback ([#923](https://github.com/ttoss/soat/issues/923)) ([6e446c3](https://github.com/ttoss/soat/commit/6e446c375dbb6fa293d044ecb06a8d2f45f14359)), closes [#888](https://github.com/ttoss/soat/issues/888) [#879](https://github.com/ttoss/soat/issues/879) [#884](https://github.com/ttoss/soat/issues/884) [#885](https://github.com/ttoss/soat/issues/885) [#887](https://github.com/ttoss/soat/issues/887) [#888](https://github.com/ttoss/soat/issues/888)

# [0.20.0](https://github.com/ttoss/soat/compare/v0.19.2...v0.20.0) (2026-08-08)

### Bug Fixes

* **orchestrations:** pin a run to the graph it started on ([#892](https://github.com/ttoss/soat/issues/892)) ([cecda04](https://github.com/ttoss/soat/commit/cecda049071c52b91f9994f5563dc8084a34d369)), closes [#880](https://github.com/ttoss/soat/issues/880) [#883](https://github.com/ttoss/soat/issues/883) [#877](https://github.com/ttoss/soat/issues/877) [#872](https://github.com/ttoss/soat/issues/872)
* **tests:** make the sonnet-workflows tutorial CI-viable ([#881](https://github.com/ttoss/soat/issues/881)) ([dd99e89](https://github.com/ttoss/soat/commit/dd99e891ea7ab3e19c42a1387ddca4d150c5969e))
* **workflows:** give a workflow-dispatched agent the same run identity a run has ([#891](https://github.com/ttoss/soat/issues/891)) ([dc289a2](https://github.com/ttoss/soat/commit/dc289a2e96492c411e339fa3cf9da058f0b576dc)), closes [#884](https://github.com/ttoss/soat/issues/884)
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

### Bug Fixes

* **agents:** fail a generation whose answer is a tool call written as text ([#870](https://github.com/ttoss/soat/issues/870)) ([b759bce](https://github.com/ttoss/soat/commit/b759bceb74489caac71a6a04d28b724a9ecb8e4c))

## [0.19.1](https://github.com/ttoss/soat/compare/v0.19.0...v0.19.1) (2026-08-07)

### Bug Fixes

* **server:** enforce agent output_schema on model output ([#867](https://github.com/ttoss/soat/issues/867)) ([155a4d1](https://github.com/ttoss/soat/commit/155a4d1c417fb302f3c5be14727ec16665093393))

# [0.19.0](https://github.com/ttoss/soat/compare/v0.18.6...v0.19.0) (2026-08-06)

### Bug Fixes

* **discussions:** type DiscussionRun attribution instead of a free-form bag ([#858](https://github.com/ttoss/soat/issues/858)) ([#862](https://github.com/ttoss/soat/issues/862)) ([6d6fdaf](https://github.com/ttoss/soat/commit/6d6fdafc6f3cd1ca5389e2f7983b733689227f99)), closes [#842](https://github.com/ttoss/soat/issues/842) [#807](https://github.com/ttoss/soat/issues/807) [#856](https://github.com/ttoss/soat/issues/856)
* **openapi:** make nullable enums declare null so generated types match ([#861](https://github.com/ttoss/soat/issues/861)) ([#863](https://github.com/ttoss/soat/issues/863)) ([fc452b4](https://github.com/ttoss/soat/commit/fc452b4aca7fdbb99ea0053dc8f85773589298dd)), closes [#858](https://github.com/ttoss/soat/issues/858)

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

* **agents,projects:** delete storage objects on force-delete cascades ([#841](https://github.com/ttoss/soat/issues/841)) ([c9ac353](https://github.com/ttoss/soat/commit/c9ac353607828dcf7b67a052790da1c88eb354f2)), closes [#835](https://github.com/ttoss/soat/issues/835)
* **conversations:** move server-recorded tool-call chain out of caller-writable metadata ([#844](https://github.com/ttoss/soat/issues/844)) ([#849](https://github.com/ttoss/soat/issues/849)) ([2c6cd29](https://github.com/ttoss/soat/commit/2c6cd29cc63ffbe540d8fbc54f51872b2f589247)), closes [#842](https://github.com/ttoss/soat/issues/842)
* **documents:** promote server-owned ingestion state out of caller-writable metadata ([#845](https://github.com/ttoss/soat/issues/845)) ([#854](https://github.com/ttoss/soat/issues/854)) ([5907882](https://github.com/ttoss/soat/commit/590788273b03cd31d5b836dbcacfe3a7b1e1082f)), closes [#842](https://github.com/ttoss/soat/issues/842)
* **projects:** count usage history as a project dependent ([#840](https://github.com/ttoss/soat/issues/840)) ([c7c1170](https://github.com/ttoss/soat/commit/c7c1170bbd72f4f2f92eb362fa82f17de59d0284)), closes [#834](https://github.com/ttoss/soat/issues/834)
* **sessions:** server-derived tool_context identity keys always win ([#848](https://github.com/ttoss/soat/issues/848)) ([eab0eb5](https://github.com/ttoss/soat/commit/eab0eb5322143b26b097cac2c48acc5bae3d4fc5)), closes [#843](https://github.com/ttoss/soat/issues/843)

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

### Bug Fixes

* **agents:** make Trace/Generation creation atomic to prevent orphaned traces ([#817](https://github.com/ttoss/soat/issues/817)) ([779946c](https://github.com/ttoss/soat/commit/779946c0ad9b6fb880f627db5bfed23b393ce0bb)), closes [#815](https://github.com/ttoss/soat/issues/815)
* **tools:** log when output_mapping var resolves to null ([#818](https://github.com/ttoss/soat/issues/818)) ([#826](https://github.com/ttoss/soat/issues/826)) ([739562b](https://github.com/ttoss/soat/commit/739562b87749fbd25ad8bd6d412ccfa83d34c422))

### Features

* **tasks:** allow creating a task in a named non-initial state ([#821](https://github.com/ttoss/soat/issues/821)) ([#830](https://github.com/ttoss/soat/issues/830)) ([c94687c](https://github.com/ttoss/soat/commit/c94687cd18d200ad23dd91ccac552ce906d6e29b))
* **tools:** add execute.auth with aws_sigv4 and gcp_service_account ([#823](https://github.com/ttoss/soat/issues/823)) ([cb06791](https://github.com/ttoss/soat/commit/cb06791835a6c5e10c2595ec24039bf69e484b1d))
* **tools:** include the merged request input in output_mapping context ([#819](https://github.com/ttoss/soat/issues/819)) ([#827](https://github.com/ttoss/soat/issues/827)) ([5142f6d](https://github.com/ttoss/soat/commit/5142f6d74725ee429b792630ba5c6db3795d03bf))
* **workflows:** deterministic payload_writes on task-automation dispatches ([#824](https://github.com/ttoss/soat/issues/824)) ([2b03612](https://github.com/ttoss/soat/commit/2b0361236cf76540ce2430349fa1f175d2f9c360)), closes [ttoss/soat#816](https://github.com/ttoss/soat/issues/816) [ttoss/soat#816](https://github.com/ttoss/soat/issues/816)
* **workflows:** retry/backoff policy for task-automation dispatches ([#822](https://github.com/ttoss/soat/issues/822)) ([#829](https://github.com/ttoss/soat/issues/829)) ([a45ea36](https://github.com/ttoss/soat/commit/a45ea360c3b6764bb3ce64a827105d848c040ab8))

## [0.18.4](https://127.0.0.1/41729/git/ttoss/compare/v0.18.3...v0.18.4) (2026-08-01)

### Bug Fixes

* **agents:** apply active_tool_ids and validate its references ([#812](https://127.0.0.1/41729/git/ttoss/issues/812)) ([f516c57](https://127.0.0.1/41729/git/ttoss/commits/f516c5706dcb1d5fa5b81d2f153791ba5deec6c5)), closes [#811](https://127.0.0.1/41729/git/ttoss/issues/811) [#809](https://127.0.0.1/41729/git/ttoss/issues/809)

## [0.18.3](https://127.0.0.1/41729/git/ttoss/compare/v0.18.2...v0.18.3) (2026-08-01)

### Bug Fixes

* **agents:** honor a string tool_choice in step_rules ([#808](https://127.0.0.1/41729/git/ttoss/issues/808)) ([9b77816](https://127.0.0.1/41729/git/ttoss/commits/9b77816eae97571363439bd579353403c6922df2)), closes [arantespp/assistentelets#34](https://127.0.0.1/arantespp/assistentelets/issues/34)

## [0.18.2](https://127.0.0.1/41729/git/ttoss/compare/v0.18.1...v0.18.2) (2026-08-01)

### Bug Fixes

* **documents:** return 409 instead of 500 when re-ingesting a file_id ([#800](https://127.0.0.1/41729/git/ttoss/issues/800)) ([48b8b87](https://127.0.0.1/41729/git/ttoss/commits/48b8b87019883a4ed4d9050cab6bb356e59efaff))

### Features

* **agents:** version snapshots and staged rollout (PRD Phases 1-2) ([#796](https://127.0.0.1/41729/git/ttoss/issues/796)) ([037d597](https://127.0.0.1/41729/git/ttoss/commits/037d597518ee2b8a43b5037578757b43749cde64))

## [0.18.1](https://127.0.0.1/41729/git/ttoss/compare/v0.18.0...v0.18.1) (2026-07-31)

### Bug Fixes

* **webhooks,triggers:** encrypt signing secrets at rest ([#793](https://127.0.0.1/41729/git/ttoss/issues/793)) ([b937d2e](https://127.0.0.1/41729/git/ttoss/commits/b937d2e3fca2e8db94ae2a0e13d265a49e592b64))
* **workflows:** reject an automation transition with no recorded cause ([#792](https://127.0.0.1/41729/git/ttoss/issues/792)) ([#792](https://127.0.0.1/41729/git/ttoss/issues/792)) ([c65bb2a](https://127.0.0.1/41729/git/ttoss/commits/c65bb2ad867128064d81f791b912ed6ea21b0712)), closes [#786](https://127.0.0.1/41729/git/ttoss/issues/786) [#786](https://127.0.0.1/41729/git/ttoss/issues/786) [#3](https://127.0.0.1/41729/git/ttoss/issues/3)

# [0.18.0](https://127.0.0.1/41729/git/ttoss/compare/v0.17.5...v0.18.0) (2026-07-30)

### Bug Fixes

* **postgresdb:** stop the mechanisms that produce bad indexes ([#780](https://127.0.0.1/41729/git/ttoss/issues/780)) ([f696c89](https://127.0.0.1/41729/git/ttoss/commits/f696c8917ea6f32aa98cf23e0b45d6a9a734151a)), closes [#508](https://127.0.0.1/41729/git/ttoss/issues/508) [#561](https://127.0.0.1/41729/git/ttoss/issues/561) [#561](https://127.0.0.1/41729/git/ttoss/issues/561) [#710](https://127.0.0.1/41729/git/ttoss/issues/710)
* **tests:** make forced tool_choice deterministic in CI; add "# → retry N" tutorial annotation ([#779](https://127.0.0.1/41729/git/ttoss/issues/779)) ([38fed24](https://127.0.0.1/41729/git/ttoss/commits/38fed241775ef130d26c13a8b0eb727bcc41f50b)), closes [#774](https://127.0.0.1/41729/git/ttoss/issues/774) [#774](https://127.0.0.1/41729/git/ttoss/issues/774)
* **website:** sync MCP docs type labels with the server's fixed schema logic ([#777](https://127.0.0.1/41729/git/ttoss/issues/777)) ([b6fd911](https://127.0.0.1/41729/git/ttoss/commits/b6fd911c7254280a382f4dbda4ffc49c0dabc44b)), closes [#770](https://127.0.0.1/41729/git/ttoss/issues/770) [#775](https://127.0.0.1/41729/git/ttoss/issues/775) [#775](https://127.0.0.1/41729/git/ttoss/issues/775)

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

### Bug Fixes

* **website:** retry forced tool_choice generation in client-tools tutorial ([#772](https://127.0.0.1/41729/git/ttoss/issues/772)) ([22aec70](https://127.0.0.1/41729/git/ttoss/commits/22aec70accdc7e1da1716674a3b7a7423fd1faa4))

## [0.17.4](https://127.0.0.1/41729/git/ttoss/compare/v0.17.3...v0.17.4) (2026-07-29)

**Note:** Version bump only for package @soat/website

## [0.17.3](https://127.0.0.1/41729/git/ttoss/compare/v0.17.1...v0.17.3) (2026-07-28)

* refactor!: rename orchestration run_id to orchestration_run_id (#763) ([74b5171](https://127.0.0.1/41729/git/ttoss/commits/74b51711c725af1a959feb13d985924b56622cd2)), closes [#763](https://127.0.0.1/41729/git/ttoss/issues/763)

### Bug Fixes

* guardrail_tripwire dedup for non-run agent calls; usage receipt mutual exclusivity; approvals action doc ([#761](https://127.0.0.1/41729/git/ttoss/issues/761)) ([6c004d8](https://127.0.0.1/41729/git/ttoss/commits/6c004d8fc1053001fc5529229bdbcceafe1ad75c)), closes [#760](https://127.0.0.1/41729/git/ttoss/issues/760) [#759](https://127.0.0.1/41729/git/ttoss/issues/759) [#758](https://127.0.0.1/41729/git/ttoss/issues/758)

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

### Bug Fixes

* guardrail_tripwire dedup for non-run agent calls; usage receipt mutual exclusivity; approvals action doc ([#761](https://127.0.0.1/41729/git/ttoss/issues/761)) ([6c004d8](https://127.0.0.1/41729/git/ttoss/commits/6c004d8fc1053001fc5529229bdbcceafe1ad75c)), closes [#760](https://127.0.0.1/41729/git/ttoss/issues/760) [#759](https://127.0.0.1/41729/git/ttoss/issues/759) [#758](https://127.0.0.1/41729/git/ttoss/issues/758)

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

* fix(tool-context)!: forward tool_context keys verbatim as header names (#753) ([4fcb53d](https://127.0.0.1/41729/git/ttoss/commits/4fcb53d6ba4249fe848958d964308d033867a4c7)), closes [#753](https://127.0.0.1/41729/git/ttoss/issues/753) [#651](https://127.0.0.1/41729/git/ttoss/issues/651) [#690](https://127.0.0.1/41729/git/ttoss/issues/690) [#729](https://127.0.0.1/41729/git/ttoss/issues/729) [#737](https://127.0.0.1/41729/git/ttoss/issues/737)

### Bug Fixes

* **quotas:** enforce requests quotas for unscoped API keys ([#749](https://127.0.0.1/41729/git/ttoss/issues/749)) ([#752](https://127.0.0.1/41729/git/ttoss/issues/752)) ([073475d](https://127.0.0.1/41729/git/ttoss/commits/073475d8423bcc2ae7d2318b77874d3f25be4c01)), closes [#742](https://127.0.0.1/41729/git/ttoss/issues/742) [#742](https://127.0.0.1/41729/git/ttoss/issues/742)
* resolve five QA-tracked defects from [#748](https://127.0.0.1/41729/git/ttoss/issues/748) (quotas, audit-log, orchestrations) ([#751](https://127.0.0.1/41729/git/ttoss/issues/751)) ([09a3e5e](https://127.0.0.1/41729/git/ttoss/commits/09a3e5e0d19ddf5991f0d53088a595da9ca4ac50)), closes [#719](https://127.0.0.1/41729/git/ttoss/issues/719) [#746](https://127.0.0.1/41729/git/ttoss/issues/746) [#749](https://127.0.0.1/41729/git/ttoss/issues/749) [#742](https://127.0.0.1/41729/git/ttoss/issues/742) [#745](https://127.0.0.1/41729/git/ttoss/issues/745) [#747](https://127.0.0.1/41729/git/ttoss/issues/747) [#747](https://127.0.0.1/41729/git/ttoss/issues/747)

### Features

* **activity:** close the last two G3 approvals-PRD deliverables ([#756](https://127.0.0.1/41729/git/ttoss/issues/756)) ([d12000c](https://127.0.0.1/41729/git/ttoss/commits/d12000c4612a9c1b722d82c2d229e2243fef09d4)), closes [#entity-graph-edges](https://127.0.0.1/41729/git/ttoss/issues/entity-graph-edges)
* **activity:** ship the G3 Phase 4 activity feed ([#755](https://127.0.0.1/41729/git/ttoss/issues/755)) ([35f2c4c](https://127.0.0.1/41729/git/ttoss/commits/35f2c4c8742d0a3fad86771f80dee5a4ddb74d20))

### BREAKING CHANGES

* the emitted `X-Soat-Context-*` header names no longer
  uppercase the key's first character. This is invisible to any client that
  looks headers up through a normal framework accessor, since header names are
  case-insensitive and HTTP/2 lowercases them on the wire. It affects only
  consumers that match the header name as an exact string, such as an API
  gateway rule, a WAF matcher, or log-based routing -- make those matches
  case-insensitive.

# [0.17.0](https://127.0.0.1/41729/git/ttoss/compare/v0.16.3...v0.17.0) (2026-07-27)

* fix(case-transform)!: stop case-converting tags, IAM conditions and mapping keys (#737) ([086dfa3](https://127.0.0.1/41729/git/ttoss/commits/086dfa382771642ef2fff4de6000098df5d87e1b)), closes [#737](https://127.0.0.1/41729/git/ttoss/issues/737) [#736](https://127.0.0.1/41729/git/ttoss/issues/736)
* fix(tool-context)!: stop case-converting tool_context keys (#736) ([8351e0f](https://127.0.0.1/41729/git/ttoss/commits/8351e0ff4fcc387c37fbdc5add125a80fb7034d8)), closes [#736](https://127.0.0.1/41729/git/ttoss/issues/736) [#735](https://127.0.0.1/41729/git/ttoss/issues/735) [#729](https://127.0.0.1/41729/git/ttoss/issues/729)

### Bug Fixes

* **case:** find and fix the real bugs PR [#739](https://127.0.0.1/41729/git/ttoss/issues/739)'s refactor left behind, module by module ([#740](https://127.0.0.1/41729/git/ttoss/issues/740)) ([d957963](https://127.0.0.1/41729/git/ttoss/commits/d957963ee87f395e4bf2a199403e051441c2c57f)), closes [#737](https://127.0.0.1/41729/git/ttoss/issues/737) [#737](https://127.0.0.1/41729/git/ttoss/issues/737) [#737](https://127.0.0.1/41729/git/ttoss/issues/737) [#737](https://127.0.0.1/41729/git/ttoss/issues/737) [#738](https://127.0.0.1/41729/git/ttoss/issues/738) [#738](https://127.0.0.1/41729/git/ttoss/issues/738) [#738](https://127.0.0.1/41729/git/ttoss/issues/738) [#738](https://127.0.0.1/41729/git/ttoss/issues/738) [#738](https://127.0.0.1/41729/git/ttoss/issues/738) [#690](https://127.0.0.1/41729/git/ttoss/issues/690)
* **orchestrations:** dedupe re-entered pause records; correct orchestration docs ([#727](https://127.0.0.1/41729/git/ttoss/issues/727)) ([a70cb62](https://127.0.0.1/41729/git/ttoss/commits/a70cb62acaa3d6f2e2fd9f14ef287d67902ac5ac)), closes [#724](https://127.0.0.1/41729/git/ttoss/issues/724) [#721](https://127.0.0.1/41729/git/ttoss/issues/721) [#722](https://127.0.0.1/41729/git/ttoss/issues/722) [#723](https://127.0.0.1/41729/git/ttoss/issues/723)

### BREAKING CHANGES

* `tool_context` keys are no longer case-converted. A caller that
  set a snake_case key and read the camelCase header must either rename the key to
  camelCase or read the snake_case header. Session-auto-populated keys
  (`sessionId` / `actorId` / `actorExternalId`) are unaffected — they are camelCase
  at the source.
* resource `tags`, IAM policy `condition`, orchestration
  `input_mapping` and approval-node `arguments` keys are no longer case-converted.
  A caller who wrote a snake_case tag key and relied on it matching a camelCase
  `soat:ResourceTag/*` condition must now spell both the same way.
* **case:** this continues #738's snake_case wire migration; the MCP
  tool surface's field casing flip (camelCase -> snake_case) is an approved
  break for #738 and needs a major version bump under the angular
  conventional-commits preset used by lerna.json.

  Fixes from the PR #740 code review, verified individually against the code
  before changing anything:

  Critical:
  - documents.ts/exceptions.ts: checkDocumentPermission/exceptionSrn built the
    authorization SRN and isAllowed() projectPublicId from `.projectId`, but
    the mapped document/exception shape only has `project_id` — every
    SRN-scoped policy or project-scoped API key resolved against
    `soat:undefined:...` and was silently denied. The bug was invisible
    because the shared test fixture's policies are action-only. Added an
    SRN-scoped-policy regression test to each route's describe block.
  - generations.ts: RESERVED_GENERATION_METADATA_KEYS only blocked the wire
    (snake_case) spellings of the usage-attribution keys, but
    updateGenerationMetadata shallow-merges caller metadata directly over the
    stored object, which uses the camelCase spelling. A caller sending
    `actionId`/`triggerId`/`runId`/`nodeId` directly bypassed validation and
    overwrote real attribution, corrupting usage/billing rollups. Added both
    spellings to the reserved list, with a regression test.

  Major:
  - workflowsValidation.ts: the wire<->internal deep key converter only
    protected `guard`/`when` (JSON Logic bodies) from recursion; an
    `on_enter.dispatch.input_mapping` — the *target* orchestration/agent's own
    input field names, author-chosen — got its keys silently renamed on every
    round-trip. Extended the opaque-bag skip-list to include it.
  - agentToolBindings.ts: an inline `tool_bindings` entry's `tool` was stored
    wire-verbatim (snake_case) while every consumer (toolsCall.ts's deny-list
    and preset-parameter handling, agentToolResolver.ts) reads camelCase —
    `denied_actions` never denied anything and `preset_parameters` were
    dropped. Added explicit wire<->camelCase converters (matching the
    legacy `tools` array's existing parseInlineToolDefinition pattern).
  - sessionGenerationHelpers.ts: processToolOutputResult wrote
    `response_messages` into a conversation message's metadata while its
    sibling writer (conversationGeneration.ts) and the only reader both use
    `responseMessages` — messages from the tool-output continuation path could
    never be re-expanded on a later turn. Aligned the spelling.
  - conversationSubResources.ts: POST /conversations/:id/generate put
    generateConversationMessage's internal result straight on the wire
    (`generationId`/`traceId`/camelCase requiredAction) instead of the
    documented `generation_id`/`trace_id`/`required_action` shape. Mapped it,
    reusing the existing mapGenerationRequiredAction helper.
  - sessionDelayHelpers.ts: the delayed-generation branch of
    triggerOrScheduleGeneration returned `documentId` while its sibling
    (triggerOrReturnMessage) already returns `document_id`. Aligned it.
  - knowledgeMemory.ts: mapEntry spread `{ similarityScore }` into a return
    type declared with `similarity_score` — compiles silently via the spread,
    bypassing excess-property checking. min_score filtering read
    `similarity_score ?? 0`, so any positive min_score dropped all memory
    results, and doc+memory relevance sort scored memory hits as 0. Fixed the
    key.
  - Dockerfile: responseContract's per-request path-match + key-walk cost is
    gated on `NODE_ENV !== 'production'`, but the production image never set
    NODE_ENV — every deployment paid the cost the file's own comment says
    production never should. Added `ENV NODE_ENV=production`.
  - exceptions.ts/auditLog.ts: `detail` is written camelCase by its producers
    (fileApprovalExpiredException, fileGuardrailTripwireException,
    quotaEvents, guardrailEvaluationRecord) and was returned verbatim in
    exceptions.ts (regressed to camelCase on the wire), while auditLog.ts used
    a *deep* recursive converter that would mangle a guardrail_evaluation
    record's nested `contextSnapshot` — an author/runtime-owned bag one level
    down (the #690 class). Both now do a shallow (top-level-only) conversion:
    correct casing for the server-owned top level, untouched nested bags.

  Verified not applicable: SDK/CLI regeneration after the files.yaml
  `content_type` fix — `packages/sdk`/`packages/cli`'s `build` script always
  runs `generate` first and the generated output is gitignored (not a
  committed artifact), so there is nothing stale to regenerate in this repo.

## [0.16.3](https://127.0.0.1/41729/git/ttoss/compare/v0.16.2...v0.16.3) (2026-07-26)

### Features

* **orchestrations:** pluggable queue drivers, SQS driver, and a standalone worker fleet ([#714](https://127.0.0.1/41729/git/ttoss/issues/714)) ([d2870f6](https://127.0.0.1/41729/git/ttoss/commits/d2870f68d6d5dda072b91f30b34649849bc96a44))

## [0.16.2](https://127.0.0.1/41729/git/ttoss/compare/v0.16.1...v0.16.2) (2026-07-26)

### Bug Fixes

* **quotas:** reject formation updates that change immutable quota fields ([#706](https://127.0.0.1/41729/git/ttoss/issues/706)) ([3a94680](https://127.0.0.1/41729/git/ttoss/commits/3a946803ae38200750e2a1b3b93f36f91cccd059)), closes [#703](https://127.0.0.1/41729/git/ttoss/issues/703)

### Features

* **guardrails:** per-run cumulative usage ceiling ([#486](https://127.0.0.1/41729/git/ttoss/issues/486)) ([#701](https://127.0.0.1/41729/git/ttoss/issues/701)) ([636a277](https://127.0.0.1/41729/git/ttoss/commits/636a277582a6f1a14cab63e0cf06fb58e845f2fa))
* **quotas:** add actor scope for per-end-user token and cost caps ([#702](https://127.0.0.1/41729/git/ttoss/issues/702)) ([2c41429](https://127.0.0.1/41729/git/ttoss/commits/2c4142998d1ace53b04043a4851b997fc133afdf)), closes [#699](https://127.0.0.1/41729/git/ttoss/issues/699)
* **usage:** attribute usage events to the end-user actor and session ([#699](https://127.0.0.1/41729/git/ttoss/issues/699)) ([06636cc](https://127.0.0.1/41729/git/ttoss/commits/06636cc3f90facb7cb85b43eba98a15386493cee)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482) [#484](https://127.0.0.1/41729/git/ttoss/issues/484)

## [0.16.1](https://127.0.0.1/41729/git/ttoss/compare/v0.16.0...v0.16.1) (2026-07-25)

### Bug Fixes

* **audit-log:** record item-scoped mutations, fix detail casing, reject bad date filters ([#697](https://127.0.0.1/41729/git/ttoss/issues/697)) ([3c77344](https://127.0.0.1/41729/git/ttoss/commits/3c77344b61884c6c26f52ad680816482e9b40144))
* **quotas:** re-arm the breach fire guard on limit change, and surface unenforceable cost caps ([#696](https://127.0.0.1/41729/git/ttoss/issues/696)) ([b4d3886](https://127.0.0.1/41729/git/ttoss/commits/b4d3886b624314bbd2dc6598f0428ce88b790390)), closes [#692](https://127.0.0.1/41729/git/ttoss/issues/692) [#694](https://127.0.0.1/41729/git/ttoss/issues/694)

### Features

* **usage:** meter chat, discussion, and memory completions (G5 coverage) ([#698](https://127.0.0.1/41729/git/ttoss/issues/698)) ([8c38f9a](https://127.0.0.1/41729/git/ttoss/commits/8c38f9a573ef2bc6b911668deffc16371a04701c)), closes [#486](https://127.0.0.1/41729/git/ttoss/issues/486)

# [0.16.0](https://127.0.0.1/41729/git/ttoss/compare/v0.15.14...v0.16.0) (2026-07-25)

### Features

* **approvals:** add read-only recurrence view (G3) ([#678](https://127.0.0.1/41729/git/ttoss/issues/678)) ([4c730cd](https://127.0.0.1/41729/git/ttoss/commits/4c730cd153bfed1adac19ab661ec6528fc48114f))
* **audit-log:** mirror decision-changing guardrail evaluations into AuditEntry (P2) ([#681](https://127.0.0.1/41729/git/ttoss/issues/681)) ([736bdf3](https://127.0.0.1/41729/git/ttoss/commits/736bdf3d758f026fd154538121eea0048106410f))
* **audit-log:** read-auditing flag, audit.entry_created webhook, NDJSON export (P3) ([#685](https://127.0.0.1/41729/git/ttoss/issues/685)) ([2a105ce](https://127.0.0.1/41729/git/ttoss/commits/2a105ce1482c06f9f863701f774129f1388640df))
* **quotas:** persist monitor-mode breach as a system audit entry ([#679](https://127.0.0.1/41729/git/ttoss/issues/679)) ([47ce5bf](https://127.0.0.1/41729/git/ttoss/commits/47ce5bfc01f90570b7a494760d850663943fd190))
* **usage:** storage and API-request metering emitters (P5, P6) ([#680](https://127.0.0.1/41729/git/ttoss/issues/680)) ([415a443](https://127.0.0.1/41729/git/ttoss/commits/415a4439593265a10ba8733dd85f7fa31366085d))

## [0.15.14](https://127.0.0.1/41729/git/ttoss/compare/v0.15.13...v0.15.14) (2026-07-24)

* feat(approvals)!: remove knowledge packages (G7); defer learned rules (G6) into an approvals recurrence view (#672) ([9ae83d9](https://127.0.0.1/41729/git/ttoss/commits/9ae83d94f041c2eb1c4fd078b3b03b9dfc0013f0)), closes [#672](https://127.0.0.1/41729/git/ttoss/issues/672)

### Bug Fixes

* **tools:** return raw text instead of 500 for a 2xx non-JSON http tool response ([#668](https://127.0.0.1/41729/git/ttoss/issues/668)) ([9792aad](https://127.0.0.1/41729/git/ttoss/commits/9792aad7e62986b56921938ef6dc538843cb0207)), closes [#667](https://127.0.0.1/41729/git/ttoss/issues/667)

### Features

* **api-keys:** return actionable API_KEY_PROJECT_SCOPE error on cross-project writes ([#674](https://127.0.0.1/41729/git/ttoss/issues/674)) ([182b2e9](https://127.0.0.1/41729/git/ttoss/commits/182b2e924cebbdc33b22395ed5910f8f5f55329c)), closes [#673](https://127.0.0.1/41729/git/ttoss/issues/673)
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

### Features

* **usage:** P4 compute metering on orchestration node completion ([#659](https://127.0.0.1/41729/git/ttoss/issues/659)) ([3e8fe27](https://127.0.0.1/41729/git/ttoss/commits/3e8fe270168d3539e831802f0f913207684b3b08))

## [0.15.12](https://127.0.0.1/41729/git/ttoss/compare/v0.15.11...v0.15.12) (2026-07-22)

### Bug Fixes

* **guardrails:** resolve snake_case var paths against camelCased runtime keys ([#634](https://127.0.0.1/41729/git/ttoss/issues/634)) ([2aa0b6b](https://127.0.0.1/41729/git/ttoss/commits/2aa0b6bacbb3561b670e28532f99991b670971f2)), closes [#633](https://127.0.0.1/41729/git/ttoss/issues/633)

### Features

* **audit-log:** Phase 1 — request id, append-only table, write hook, read API, retention ([#641](https://127.0.0.1/41729/git/ttoss/issues/641)) ([4a16724](https://127.0.0.1/41729/git/ttoss/commits/4a16724f8be66998d618760eea484882d2eb3746))
* **exceptions:** G3 Phase 3 — first-class exception queue ([#648](https://127.0.0.1/41729/git/ttoss/issues/648)) ([5b5871c](https://127.0.0.1/41729/git/ttoss/commits/5b5871c38dabf8b15dba9199df6b1164a20cbc58))
* **formations:** add guardrail as a declarable Formation resource (F-17) ([#643](https://127.0.0.1/41729/git/ttoss/issues/643)) ([6802722](https://127.0.0.1/41729/git/ttoss/commits/68027222264bef9049d15fe4b32030ba4f382a4f))
* **guardrails:** gate orchestration tool nodes at dispatch ([#646](https://127.0.0.1/41729/git/ttoss/issues/646)) ([1f46da2](https://127.0.0.1/41729/git/ttoss/commits/1f46da28d542b434179a12f18a2a90bd29bffe58))
* **guardrails:** per-guardrail approval expiry via document expires_in ([#647](https://127.0.0.1/41729/git/ttoss/issues/647)) ([a0f373d](https://127.0.0.1/41729/git/ttoss/commits/a0f373d15540afdd4672f77b8de968d3751c708c))
* **orchestrations:** concurrency limits (per project + global) ([#642](https://127.0.0.1/41729/git/ttoss/issues/642)) ([e8c0b88](https://127.0.0.1/41729/git/ttoss/commits/e8c0b88425c6f1b9401fa18dc0293c7b120bf23a))
* **orchestrations:** queue-backed durable execution + idempotency keys (P1) ([#628](https://127.0.0.1/41729/git/ttoss/issues/628)) ([4b265ea](https://127.0.0.1/41729/git/ttoss/commits/4b265ea9da9df39c309e0130428fddff4bceff5e))
* **quotas:** Phase 1 — requests quotas, CRUD, and 429 middleware ([#631](https://127.0.0.1/41729/git/ttoss/issues/631)) ([6c66445](https://127.0.0.1/41729/git/ttoss/commits/6c664457bd3d49bbb7407f70738370fd0c0e0856))
* **quotas:** Phase 2 — token/cost quotas at the pre-generation check ([#635](https://127.0.0.1/41729/git/ttoss/issues/635)) ([c9a50cc](https://127.0.0.1/41729/git/ttoss/commits/c9a50cc881fefb87b5eea727f20133494bf68f06))
* **quotas:** Phase 3 — quota.exceeded webhook, monitor mode, formation resource ([#636](https://127.0.0.1/41729/git/ttoss/issues/636)) ([a4f8602](https://127.0.0.1/41729/git/ttoss/commits/a4f860244914fe67521069b971d3780e439b2cbd))

## [0.15.11](https://127.0.0.1/41729/git/ttoss/compare/v0.15.10...v0.15.11) (2026-07-20)

### Features

* **guardrails:** action-class evaluation engine + guardrail_ids attach layer (task 2.2) ([#620](https://127.0.0.1/41729/git/ttoss/issues/620)) ([13d50e2](https://127.0.0.1/41729/git/ttoss/commits/13d50e20f3cf19651fb796eb773fda2720996648))
* **guardrails:** action-class guardrails — M2 contract + resource (task 2.1) ([#582](https://127.0.0.1/41729/git/ttoss/issues/582)) ([6e7b99b](https://127.0.0.1/41729/git/ttoss/commits/6e7b99b1847f0bf6739445bb20505fbac6894831))
* **guardrails:** deprecate per-binding approval_policy as a routing source (task 2.7) ([#622](https://127.0.0.1/41729/git/ttoss/issues/622)) ([07de018](https://127.0.0.1/41729/git/ttoss/commits/07de018ba5065f3493701460e019af7e00d2a2c0))
* **guardrails:** remove per-binding approval_policy (task 2.8, breaking) ([#623](https://127.0.0.1/41729/git/ttoss/issues/623)) ([8a3152e](https://127.0.0.1/41729/git/ttoss/commits/8a3152ea6e6de05aceb4ac8b8a96c0ea3faa893c))

### BREAKING CHANGES

* **guardrails:** the per-binding `approval_policy` on agent tool_bindings
  has been removed. Attach a guardrail instead (a `{ "class": "C" }`
  guardrail on the tool reproduces a `require_approval` binding).
  Guardrails are the sole tool-call gating mechanism.

## [0.15.10](https://127.0.0.1/41729/git/ttoss/compare/v0.15.9...v0.15.10) (2026-07-19)

### Bug Fixes

* **ai-providers:** handle dependents on delete instead of surfacing 500 ([#615](https://127.0.0.1/41729/git/ttoss/issues/615)) ([a62019c](https://127.0.0.1/41729/git/ttoss/commits/a62019c17b350eae197ab1da0287bd02b9194894))
* **workflows,tasks,users,mcp,cli:** resolve issues [#604](https://127.0.0.1/41729/git/ttoss/issues/604)–[#611](https://127.0.0.1/41729/git/ttoss/issues/611) ([#613](https://127.0.0.1/41729/git/ttoss/issues/613)) ([ab951df](https://127.0.0.1/41729/git/ttoss/commits/ab951df309525cf2e266d82e667b7418e5fc02a3)), closes [#605](https://127.0.0.1/41729/git/ttoss/issues/605) [#606](https://127.0.0.1/41729/git/ttoss/issues/606) [#607](https://127.0.0.1/41729/git/ttoss/issues/607) [#608](https://127.0.0.1/41729/git/ttoss/issues/608) [#609](https://127.0.0.1/41729/git/ttoss/issues/609) [#610](https://127.0.0.1/41729/git/ttoss/issues/610)

### Features

* **workflows:** Phase 3 — approval-gated transitions and stall/SLA sweeper ([#612](https://127.0.0.1/41729/git/ttoss/issues/612)) ([2265e3b](https://127.0.0.1/41729/git/ttoss/commits/2265e3bfc87bde66bb85d03a3189ce6f4d2e77cf)), closes [#591](https://127.0.0.1/41729/git/ttoss/issues/591)
* **workflows:** Phase 4 — formation resource + generic board view ([#593](https://127.0.0.1/41729/git/ttoss/issues/593)) ([#614](https://127.0.0.1/41729/git/ttoss/issues/614)) ([45507ff](https://127.0.0.1/41729/git/ttoss/commits/45507ff53435eae757e014278078b6d58d755e0f))

## [0.15.9](https://127.0.0.1/41729/git/ttoss/compare/v0.15.8...v0.15.9) (2026-07-18)

### Bug Fixes

* **tasks:** make post-dispatch automation writes atomic under a row lock ([#601](https://127.0.0.1/41729/git/ttoss/issues/601)) ([5cc147b](https://127.0.0.1/41729/git/ttoss/commits/5cc147bf16e8142f74cdf11e2ce30f02aa3f3421)), closes [#589](https://127.0.0.1/41729/git/ttoss/issues/589) [#590](https://127.0.0.1/41729/git/ttoss/issues/590)
* **tasks:** shallow-merge task payload on PATCH instead of replacing it ([#600](https://127.0.0.1/41729/git/ttoss/issues/600)) ([bca33bb](https://127.0.0.1/41729/git/ttoss/commits/bca33bb7fc21986f44a2cf138d1419222197cfee))
* **tasks:** surface guard-rejected on_complete transitions instead of leaving tasks silently stuck ([#599](https://127.0.0.1/41729/git/ttoss/issues/599)) ([6a1a851](https://127.0.0.1/41729/git/ttoss/commits/6a1a8516d853b26f6d5741e74ff1b0e263cee0ee)), closes [#589](https://127.0.0.1/41729/git/ttoss/issues/589)
* **workflows:** reject requires_approval: true at validation until Phase 3 ships ([#602](https://127.0.0.1/41729/git/ttoss/issues/602)) ([1e708f6](https://127.0.0.1/41729/git/ttoss/commits/1e708f6713e6ddd7f0f1d83ada7d55677ef3143d))

## [0.15.8](https://127.0.0.1/41729/git/ttoss/compare/v0.15.7...v0.15.8) (2026-07-18)

### Features

* **workflows,tasks:** stateful work-item module (workflows PRD, Phases 1–2) ([#583](https://127.0.0.1/41729/git/ttoss/issues/583)) ([4582786](https://127.0.0.1/41729/git/ttoss/commits/45827865bf3a5141c4401ddc638585ccfe37518a))

## [0.15.7](https://127.0.0.1/41729/git/ttoss/compare/v0.15.6...v0.15.7) (2026-07-18)

### Bug Fixes

* **formations:** reject substitution expressions in the static metadata field (F-16) ([#580](https://127.0.0.1/41729/git/ttoss/issues/580)) ([459eb80](https://127.0.0.1/41729/git/ttoss/commits/459eb80ccab7ec95d7e4e2004b416f340a520480))

### Features

* **agents,approvals:** tool-call approval interception on every surface (Milestone 1) ([#581](https://127.0.0.1/41729/git/ttoss/issues/581)) ([da69b2e](https://127.0.0.1/41729/git/ttoss/commits/da69b2e0271e441b9bd4b3d13f7fa0f7ffe1c4c9)), closes [#2](https://127.0.0.1/41729/git/ttoss/issues/2)
* **api-keys:** support unscoped API keys (optional project_id) ([#584](https://127.0.0.1/41729/git/ttoss/issues/584)) ([00360c2](https://127.0.0.1/41729/git/ttoss/commits/00360c2725e35e2c4b00a0f2f965c04bdc234a05))

## [0.15.6](https://127.0.0.1/41729/git/ttoss/compare/v0.15.5...v0.15.6) (2026-07-17)

### Bug Fixes

* **formations:** resolve sub/param/ref in top-level template metadata ([#578](https://127.0.0.1/41729/git/ttoss/issues/578)) ([842e496](https://127.0.0.1/41729/git/ttoss/commits/842e496e257159d9ae84051a8c33f3b761f0581e))

### Features

* **generations:** support writable generation.metadata (F-15) ([#577](https://127.0.0.1/41729/git/ttoss/issues/577)) ([10c8f14](https://127.0.0.1/41729/git/ttoss/commits/10c8f14c306e2ff79c276d28dccd0a0172bdf0df))

## [0.15.5](https://127.0.0.1/41729/git/ttoss/compare/v0.15.4...v0.15.5) (2026-07-17)

### Bug Fixes

* **formations:** persist document chunk config so plans converge (F-13) ([#570](https://127.0.0.1/41729/git/ttoss/issues/570)) ([9549e21](https://127.0.0.1/41729/git/ttoss/commits/9549e2113b84042f31284ea1f3b6d4df41018502))

### Features

* **formations:** add project_price resource type for declarable usage pricing ([#572](https://127.0.0.1/41729/git/ttoss/issues/572)) ([33f9601](https://127.0.0.1/41729/git/ttoss/commits/33f960104adb095c8681b44fdbf9383076971aab))
* **memories:** per-entry tags/metadata and entry-granularity tag filtering ([#571](https://127.0.0.1/41729/git/ttoss/issues/571)) ([0955ebc](https://127.0.0.1/41729/git/ttoss/commits/0955ebc819175d9002baa8fb4d456f0463f8eae5))

## [0.15.4](https://127.0.0.1/41729/git/ttoss/compare/v0.15.3...v0.15.4) (2026-07-16)

### Bug Fixes

* **formations:** expose plan-formation diff and fix false-positive updates ([#560](https://127.0.0.1/41729/git/ttoss/issues/560)) ([07d0e25](https://127.0.0.1/41729/git/ttoss/commits/07d0e25bea78686443c5ca435501e8f1adc510a8))

### Features

* **usage:** per-run cost — run/node attribution, run receipt, run roll-up (Milestone 1) ([#562](https://127.0.0.1/41729/git/ttoss/issues/562)) ([7273bfb](https://127.0.0.1/41729/git/ttoss/commits/7273bfbbcb0bb65f638f4eaf2d916f502a58fdeb))
* **usage:** project usage aggregate endpoint (Milestone 3.1) ([#564](https://127.0.0.1/41729/git/ttoss/issues/564)) ([272fb39](https://127.0.0.1/41729/git/ttoss/commits/272fb3938a7559f3e6322ccf20b173351387fc64))
* **usage:** usage thresholds + threshold-crossed webhook (Milestone 3.2/3.3) ([#565](https://127.0.0.1/41729/git/ttoss/issues/565)) ([d04d3d8](https://127.0.0.1/41729/git/ttoss/commits/d04d3d8ed24980316e250dcae9f83585580cf0e9))

## [0.15.3](https://127.0.0.1/41729/git/ttoss/compare/v0.15.2...v0.15.3) (2026-07-16)

### Bug Fixes

* **server:** bound boot schema-sync advisory-lock wait ([#549](https://127.0.0.1/41729/git/ttoss/issues/549)) ([978a27c](https://127.0.0.1/41729/git/ttoss/commits/978a27c5f6f04a42016089a9c04998ee898e8217))

### Features

* **orchestrations:** add require_delivery to webhook emit node (F-12) ([#554](https://127.0.0.1/41729/git/ttoss/issues/554)) ([6f74ce7](https://127.0.0.1/41729/git/ttoss/commits/6f74ce7dde856e4e0287e0181c190a75f726085a))

## [0.15.2](https://127.0.0.1/41729/git/ttoss/compare/v0.15.1...v0.15.2) (2026-07-15)

### Bug Fixes

* **server:** document_paths prefix filter, boundary-gated write_memory, signed webhook emit ([#545](https://127.0.0.1/41729/git/ttoss/issues/545)) ([ed3965d](https://127.0.0.1/41729/git/ttoss/commits/ed3965dbb88be2ffebb4490f0e2aa8dbbd08fbc8))

### Features

* **server:** serialize boot-time schema sync with a Postgres advisory lock ([#544](https://127.0.0.1/41729/git/ttoss/issues/544)) ([d59bba7](https://127.0.0.1/41729/git/ttoss/commits/d59bba73b9ef7327360201b05b5383fce7b01334))

## [0.15.1](https://127.0.0.1/41729/git/ttoss/compare/v0.15.0...v0.15.1) (2026-07-15)

**Note:** Version bump only for package @soat/website

# [0.15.0](https://127.0.0.1/41729/git/ttoss/compare/v0.14.12...v0.15.0) (2026-07-14)

### Features

* **approvals:** add the approval orchestration node producer ([#538](https://127.0.0.1/41729/git/ttoss/issues/538)) ([90fd793](https://127.0.0.1/41729/git/ttoss/commits/90fd793c570e53a5e91e39d7addb91c044009c8e)), closes [#1](https://127.0.0.1/41729/git/ttoss/issues/1)
* **website:** improve SEO with meta descriptions, robots.txt, and structured data ([#535](https://127.0.0.1/41729/git/ttoss/issues/535)) ([60b7c94](https://127.0.0.1/41729/git/ttoss/commits/60b7c94c809c630ea0cf7df6cf8b8a0e3454fc92))

## [0.14.12](https://127.0.0.1/41729/git/ttoss/compare/v0.14.11...v0.14.12) (2026-07-14)

### Features

* **tools:** scope mcp tools with a denied_actions denylist ([#533](https://127.0.0.1/41729/git/ttoss/issues/533)) ([838bab1](https://127.0.0.1/41729/git/ttoss/commits/838bab1dee653aa32e72c8203e1290609f47e8ef)), closes [#521](https://127.0.0.1/41729/git/ttoss/issues/521)

## [0.14.11](https://127.0.0.1/41729/git/ttoss/compare/v0.14.10...v0.14.11) (2026-07-14)

### Bug Fixes

* **server:** orchestration var resolution, extraction gating, error messages ([#526](https://127.0.0.1/41729/git/ttoss/issues/526)) ([a16cccd](https://127.0.0.1/41729/git/ttoss/commits/a16cccd395e3e567b0b353296d8d82a370fc58d7))

## [0.14.10](https://127.0.0.1/41729/git/ttoss/compare/v0.14.9...v0.14.10) (2026-07-12)

### Bug Fixes

* **server:** scope memory-only knowledge injection and normalize formation knowledge_config casing ([#524](https://127.0.0.1/41729/git/ttoss/issues/524)) ([ed5503f](https://127.0.0.1/41729/git/ttoss/commits/ed5503f5e3290b74849475283e93b0047035a04b))

## [0.14.9](https://github.com/ttoss/soat/compare/v0.14.8...v0.14.9) (2026-07-12)

### Bug Fixes

* **formations:** stop re-reporting tombstoned resources, align plan with update ([#520](https://github.com/ttoss/soat/issues/520)) ([e1c26b0](https://github.com/ttoss/soat/commit/e1c26b0563b3832c9c189f4f3a7de223423db4b3))

### Features

* **tools:** scope mcp tools to a subset of actions ([#521](https://github.com/ttoss/soat/issues/521)) ([285f3ca](https://github.com/ttoss/soat/commit/285f3ca71f7ba2ece3f3fe4ae39b42c24bf530c4))

## [0.14.8](https://github.com/ttoss/soat/compare/v0.14.7...v0.14.8) (2026-07-11)

**Note:** Version bump only for package @soat/website

## [0.14.7](https://github.com/ttoss/soat/compare/v0.14.6...v0.14.7) (2026-07-10)

**Note:** Version bump only for package @soat/website

## [0.14.6](https://github.com/ttoss/soat/compare/v0.14.5...v0.14.6) (2026-07-10)

### Bug Fixes

* CLI positional/--id support, formation params, and tool header casing ([#512](https://github.com/ttoss/soat/issues/512)) ([693ff65](https://github.com/ttoss/soat/commit/693ff6542bccc386165aaa593d8e59022c8f198e)), closes [#511](https://github.com/ttoss/soat/issues/511)
* **server:** preserve formation template key casing on read-back ([#511](https://github.com/ttoss/soat/issues/511)) ([981df4a](https://github.com/ttoss/soat/commit/981df4a62c55fb8b0ed6f7e6f4138765f95195d9))

## [0.14.5](https://127.0.0.1/41729/git/ttoss/compare/v0.14.4...v0.14.5) (2026-07-09)

**Note:** Version bump only for package @soat/website

## [0.14.4](https://127.0.0.1/41729/git/ttoss/compare/v0.14.3...v0.14.4) (2026-07-08)

### Bug Fixes

* **server:** boot on Aurora PostgreSQL 18.3 and surface DB connect errors ([#506](https://127.0.0.1/41729/git/ttoss/issues/506)) ([3078bb6](https://127.0.0.1/41729/git/ttoss/commits/3078bb69a38cae0b2517616124bb07bd1d1faf60))

### Features

* **ai-providers:** project self-service per-provider price overrides ([#498](https://127.0.0.1/41729/git/ttoss/issues/498)) ([#501](https://127.0.0.1/41729/git/ttoss/issues/501)) ([2880cf1](https://127.0.0.1/41729/git/ttoss/commits/2880cf1800f5972ac2c567af561cb28099df3df8))
* **pricing:** project + provider-slug price tier (3-tier pricing) ([#502](https://127.0.0.1/41729/git/ttoss/issues/502)) ([#504](https://127.0.0.1/41729/git/ttoss/issues/504)) ([b427abe](https://127.0.0.1/41729/git/ttoss/commits/b427abe1b84f7478dba510d0c4285970b66e7052))
* **usage:** per-generation billing receipt and price_id link ([#487](https://127.0.0.1/41729/git/ttoss/issues/487)) ([#496](https://127.0.0.1/41729/git/ttoss/issues/496)) ([55a4ee7](https://127.0.0.1/41729/git/ttoss/commits/55a4ee7ea89db7976b28b994ea55e3adaaa1ca21))

## [0.14.3](https://127.0.0.1/41729/git/ttoss/compare/v0.14.2...v0.14.3) (2026-07-08)

### Features

* **usage:** attribute usage meters to trace_id ([#484](https://127.0.0.1/41729/git/ttoss/issues/484)) ([#490](https://127.0.0.1/41729/git/ttoss/issues/490)) ([a46f70d](https://127.0.0.1/41729/git/ttoss/commits/a46f70dcdd2d5e2be2ac60e4769aa9b893b4509b)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482)
* **usage:** attribute usage meters to trigger and logical action id ([#485](https://127.0.0.1/41729/git/ttoss/issues/485)) ([#491](https://127.0.0.1/41729/git/ttoss/issues/491)) ([a00b0e5](https://127.0.0.1/41729/git/ttoss/commits/a00b0e593ef3ebff56823c28650157b7f63ca9a7)), closes [#486](https://127.0.0.1/41729/git/ttoss/issues/486) [#482](https://127.0.0.1/41729/git/ttoss/issues/482)
* **usage:** per-generation token metering with reasoning tokens ([#483](https://127.0.0.1/41729/git/ttoss/issues/483)) ([#489](https://127.0.0.1/41729/git/ttoss/issues/489)) ([5c397f5](https://127.0.0.1/41729/git/ttoss/commits/5c397f566d32358daee89462a41883343d842fa2)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482)
* **usage:** price book + write-time cost + default prices ([#488](https://127.0.0.1/41729/git/ttoss/issues/488)) ([#493](https://127.0.0.1/41729/git/ttoss/issues/493)) ([3063e64](https://127.0.0.1/41729/git/ttoss/commits/3063e640c454e1f02c5d1c7dd7a2f3307fb36f29)), closes [#482](https://127.0.0.1/41729/git/ttoss/issues/482) [#483](https://127.0.0.1/41729/git/ttoss/issues/483) [#483](https://127.0.0.1/41729/git/ttoss/issues/483) [#484](https://127.0.0.1/41729/git/ttoss/issues/484) [#485](https://127.0.0.1/41729/git/ttoss/issues/485) [#486](https://127.0.0.1/41729/git/ttoss/issues/486) [#482](https://127.0.0.1/41729/git/ttoss/issues/482)

## [0.14.2](https://127.0.0.1/41729/git/ttoss/compare/v0.14.1...v0.14.2) (2026-07-08)

### Bug Fixes

* **tools/formations:** preserve http tool input casing; support { ref } tool_id; cover inline-tool name validation ([#479](https://127.0.0.1/41729/git/ttoss/issues/479)) ([959b491](https://127.0.0.1/41729/git/ttoss/commits/959b4912dc886cd14145b892b3ae67c3d10dc80f))

## [0.14.1](https://127.0.0.1/41729/git/ttoss/compare/v0.14.0...v0.14.1) (2026-07-07)

### Features

* **server:** implement S3 file storage provider ([#472](https://127.0.0.1/41729/git/ttoss/issues/472)) ([b90e721](https://127.0.0.1/41729/git/ttoss/commits/b90e721cb6835e0d994e7500a35aabd68638415f))
* **server:** support OpenAI and Bedrock embedding providers ([#473](https://127.0.0.1/41729/git/ttoss/issues/473)) ([b5d7fcf](https://127.0.0.1/41729/git/ttoss/commits/b5d7fcf41804e160b46d1cbe16f4453f87f34836))

# [0.14.0](https://127.0.0.1/41729/git/ttoss/compare/v0.13.20...v0.14.0) (2026-07-05)

### Features

* **orchestrations:** crash recovery for in-flight runs (orphaned-run reaper) ([#415](https://127.0.0.1/41729/git/ttoss/issues/415)) ([c3148b3](https://127.0.0.1/41729/git/ttoss/commits/c3148b322c47c94cdd9e2bdada7ea1a0e6bb77d7)), closes [#407](https://127.0.0.1/41729/git/ttoss/issues/407) [#403](https://127.0.0.1/41729/git/ttoss/issues/403) [#404](https://127.0.0.1/41729/git/ttoss/issues/404) [#404](https://127.0.0.1/41729/git/ttoss/issues/404)
* **orchestrations:** per-node retry policy with backoff (R2.3) ([#416](https://127.0.0.1/41729/git/ttoss/issues/416)) ([22992a8](https://127.0.0.1/41729/git/ttoss/commits/22992a868c4ab3d0fbe10d11af20061c564fa6cd)), closes [#407](https://127.0.0.1/41729/git/ttoss/issues/407) [#403](https://127.0.0.1/41729/git/ttoss/issues/403) [#405](https://127.0.0.1/41729/git/ttoss/issues/405) [#405](https://127.0.0.1/41729/git/ttoss/issues/405)

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
