# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
