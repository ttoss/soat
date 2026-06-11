# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
