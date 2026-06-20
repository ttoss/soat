# Plan — De-boilerplate SOAT via ttoss

| | |
|---|---|
| **Status** | Draft / Analysis |
| **Scope** | `@soat/server`, `@soat/app`, `@soat/sdk`, `@soat/cli`, `@soat/website`, `@soat/postgresdb` |
| **Goal** | Remove SOAT boilerplate by (A) adopting recently-shipped ttoss packages and (B) generalizing SOAT's reusable infrastructure into ttoss |
| **Author** | Generated analysis (Claude Code) |
| **Last updated** | 2026-06-20 |

## 1. Executive summary

SOAT is **already** built on the ttoss HTTP stack — `@ttoss/http-server`, `@ttoss/http-server-auth`, `@ttoss/http-server-mcp`, `@ttoss/auth-core`, and `@ttoss/postgresdb`. The de-boilerplate opportunity splits into two directions:

- **Direction A — Adopt from ttoss (SOAT shrinks now).** In its most recent ~40 merged PRs, ttoss shipped exactly the things SOAT currently hand-rolls: OAuth **consent** (`createRedirectConsentOnAuthorize` + a **Postgres consent store**), an `OAuthConsent` React component, MCP **RFC 9728 discovery / scopes / OAuth**, a reusable third-party `oauth-client`, and UI packages (`react-dashboard`, `layouts/Sidebar`, `components`, `forms`, `react-notifications`). SOAT's pinned `@ttoss/*` versions are **behind** these.
- **Direction B — Generalize SOAT → ttoss (ecosystem gains; SOAT consumes back).** SOAT contains roughly **8–9k LOC of generic, OpenAPI-driven infrastructure** that ttoss has no equivalent for: OpenAPI→MCP tools, OpenAPI→CLI, OpenAPI→SDK merge, an IAM/policy engine, a case-transform middleware, a Formations (IaC) engine, and OpenAPI→docs generators.

> **Note on this document.** This is an assessment, not an implementation. Direction B requires PRs in **`ttoss/ttoss`**, which is outside the current session's repo scope. Direction A and the SOAT-side of every extraction can be done in this repo.

## 2. Context — SOAT already runs on ttoss

The seam today (from `import … from '@ttoss/*'`):

| Package | Used in SOAT for |
|---|---|
| `@ttoss/http-server` | `App`, `Router`, `bodyParser`, `cors`, `addHealthCheck`, `Context`/`Next`/`Middleware` types — `src/app.ts`, every `rest/v1/*.ts` |
| `@ttoss/http-server-auth` | `oauthServer()` — the OAuth 2.1 authorization-server router in `src/oauth/server.ts` |
| `@ttoss/http-server-mcp` | `createMcpRouter`, `McpServer`, `registerToolFromSchema`, `apiCall` — `src/mcp/server.ts`, `src/lib/soatToolsHelpers.ts` |
| `@ttoss/auth-core` | `createMemoryAuthCodeStore`, `createMemoryClientStore`, `signJwt`, `verifyJwt` — `src/oauth/server.ts` |
| `@ttoss/postgresdb` | Sequelize model base for all 28 models in `packages/postgresdb/src/models/*` |
| `@ttoss/config`, `@ttoss/test-utils`, `@ttoss/logger`, `@ttoss/monorepo`, `@ttoss/eslint-config`, `@ttoss/postgresdb-cli` | tooling, tests, CLI logging, monorepo config |

Because SOAT is already a heavy ttoss consumer, the cheapest wins are **version bumps + swapping hand-rolled code for the new package APIs**.

## 3. The boilerplate, quantified

| Surface | Count | Repetition |
|---|---|---|
| REST route files (`rest/v1/*.ts`) | 33 | each re-inlines the 401/403 check + project-id resolution + policy compilation |
| OpenAPI YAMLs (`rest/openapi/v1/*.yaml`) | 22 | source of truth for SDK / CLI / MCP / docs |
| Permission JSONs (`permissions/*.json`) | 21 | `operationId → action` maps |
| Formation modules (`lib/formation-modules/*`) | 15 (~2,778 LOC) | identical `validate → create/update/delete/read` skeleton |
| lib modules (`lib/*.ts`) | 76 | business logic and generic infra mixed |
| postgresdb models | 28 | `@ttoss/postgresdb` + prefixed-nanoid `publicId` pattern |

Generic infrastructure LOC that is **not** SOAT business logic:

| Area | Files | ~LOC |
|---|---|---|
| Server infra | `iam.ts` (408), `policyCompiler.ts` (362), `soatTools*.ts` (625), `formations*.ts` (~1,477), `caseTransform.ts` (85), `openapiSpec.ts` (80), `permission*.ts` (263) | ~3,765 |
| App "engine" | `app/src/engine/*` (specUtils, listView, detailView, formView, formHelpers, routeUtils) | ~2,756 |
| Website doc generators | `website/scripts/generate*.ts` | ~1,685 |
| SDK + CLI generators | `sdk/scripts/generate.ts` (126), `cli/scripts/generate.ts` (339) | ~465 |
| **Total reusable infra living in SOAT** | | **~8,700** |

## 4. Direction A — Adopt from ttoss (removes SOAT code)

Ranked by value ÷ risk. PR numbers reference `ttoss/ttoss`.

### A1. OAuth consent → `@ttoss/auth-core` + `@ttoss/components` — *highest value; also fixes a bug*
- **Today:** `src/oauth/server.ts` keeps consent in an **in-memory** `consentSessions = new Map()` with `putConsentSession` / `takeConsentSession`, a `soat_consent` cookie, and `buildConsentRedirect()` to `/app/oauth/consent`; plus `lib/oauthConsent.ts` (113 LOC) and `rest/v1/oauth.ts` (178 LOC); plus a hand-built consent screen in the SPA.
- **ttoss now ships:** **#1094** `createRedirectConsentOnAuthorize` + **Postgres consent store**; **#1093** `<OAuthConsent>` component with **hierarchical scope support** (maps onto SOAT's `all / modules / actions` tiers).
- **Win:** deletes the consent `Map`, cookie plumbing, and redirect builder; collapses the SPA screen to the ttoss component; **fixes** the correctness bug that consent is lost on restart / not shared across instances.

### A2. Persistent OAuth stores → drop `createMemory*Store`
- **Today:** `createMemoryClientStore()` and `createMemoryAuthCodeStore()` — DCR clients and auth codes vanish on restart.
- **Adopt:** the Postgres-backed stores from the same OAuth-primitives line of work (**#1045 / #1047 / #1059 / #1094**).

### A3. MCP: lean on `@ttoss/http-server-mcp` built-ins
- **Relevant PRs:** **#1068** RFC 9728 discovery + public MCP methods in `createMcpRouter`; **#1091** root mounting + protected-resource metadata URL fix; **#1090** accept `scopes[]` + warn on missing scope claim; **#1016 / #1059 / #1047** OAuth 2.1 for MCP; **#1061** `ctx` passed to auth callbacks.
- **Today:** `src/mcp/server.ts` forwards the bearer token by hand via `getApiHeaders`. Newer `http-server-mcp` can own discovery + scope handling → less custom glue, standards-compliant discovery.

### A4. Frontend chrome → ttoss UI packages
- **Today:** `@soat/app` hand-rolls radix + tailwind primitives (`input`/`label`/`switch`/`button` via CVA), `statusBadge`, `methodBadge`, and its own workspace / sidebar / nav.
- **Adopt:** `@ttoss/layouts` **Sidebar** (#1015); `@ttoss/react-dashboard` list/detail + **composable filters** (#1087); `@ttoss/components` (#1076 / #1054); `@ttoss/forms` (RHF + Zod — replaces `formHelpers` / `formView`); `@ttoss/react-notifications` (#1080).
- **Keep** SOAT's OpenAPI→view-model layer; render with ttoss primitives (see B9).

### A5. Third-party LLM connections → `@ttoss/oauth-client` (#1074)
- SOAT has a "connect third-party LLMs" flow; the reusable third-party OAuth **client** package fits it directly.

### A6. (Optional) `@ttoss/http-server-serverless` (#1089)
- AWS Lambda adapter — only relevant if SOAT moves off the long-lived Koa `app.listen()`.

## 5. Direction B — Generalize SOAT → ttoss

ttoss has **no OpenAPI tooling** packages today — SOAT's biggest contribution surface. Ranked by reuse ÷ extraction effort.

### B1. `caseTransform` middleware → `@ttoss/http-server` — *small, high reuse*
85 LOC of snake_case ↔ camelCase for REST bodies / queries / responses. Generic Koa middleware; natural fit in the existing package.

### B2. OpenAPI→MCP tools → into `@ttoss/http-server-mcp` — *medium, natural home*
`soatTools.ts` + helpers (625 LOC) turn a directory of OpenAPI specs into MCP tool defs with `path` / `query` / `body` builders + `iamAction`. Already sits *on top of* ttoss's `registerToolFromSchema`; promote to e.g. `registerOpenApiTools({ specsDir })`.

### B3. OpenAPI spec-merge util → `@ttoss/openapi` — *small; also removes in-SOAT duplication*
Merging per-module YAML into one spec is implemented **twice** in SOAT: `sdk/scripts/generate.ts` (build-time) and `lib/openapiSpec.ts` (runtime). Extract one shared util.

### B4. IAM / policy engine → `@ttoss/iam` — *large, very high reuse*
`iam.ts` (408) + `policyCompiler.ts` (362) + `permissions.ts` / `permissionCatalog.ts` (263): AWS-style policy documents (effect/action/resource), ARN-like **SRN** resource patterns, evaluation, **policy → Sequelize `WHERE`** compilation, and a JSON-declared action catalog. ttoss has cloud-IAM (CloudFormation) but no *application-level* authZ engine.

### B5. OpenAPI→CLI generator → `@ttoss/openapi-cli` — *medium*
`cli/scripts/generate.ts` (339) + dispatcher build a commander CLI from the spec (kebab commands, path/query/body flags, `oneOf` handling). Fully generic.

### B6. OpenAPI→docs generators → `@ttoss/openapi-docusaurus` — *medium*
~1,685 LOC generating SDK-service / CLI-command / MCP-tool / spec / permissions / formations docs pages.

### B7. Formations (IaC) engine → `@ttoss/formations` — *large, novel*
Declarative template → plan → apply (create/update/delete) with drift via `lastAppliedProperties`, a resource-module registry, and schema-driven validation from OpenAPI. Engine core is generic; the 15 per-resource modules stay in SOAT.

### B8. `publicId` generator — *tiny*
Stripe-style prefixed nanoid (`proj_…`, `agt_…`). Fold into `@ttoss/postgresdb`.

### B9. OpenAPI→React admin engine → `@ttoss/react-openapi-admin` — *large*
`specUtils.parseModules` + list/detail/form/route views (2,756 LOC) layered on `@ttoss/react-dashboard`. Couples with A4.

## 6. Recommended sequence

1. **A1 + A2** — biggest boilerplate delete *and* fixes the in-memory-consent correctness bug; stays inside SOAT. Likely needs `@ttoss/auth-core` / `-auth` version bumps (SOAT is on `auth-core ^0.7.0`, `http-server-auth ^0.3.3`).
2. **B1 + B3** — cheap extractions with immediate cleanup (B3 also removes an existing in-SOAT duplication).
3. **B2** — promote OpenAPI→MCP into the package SOAT already imports.
4. **A4 / A3**, then the larger **B4 / B7 / B9** as multi-PR efforts.

## 7. Caveats

- **Cross-repo.** Direction B requires PRs in **`ttoss/ttoss`**, outside the current session scope (locked to `ttoss/soat`). SOAT-side preparation can proceed; the ttoss PRs need a session scoped to that repo.
- **Versions.** Adopt items rely on PRs newer than SOAT's pinned `@ttoss/*`; expect version bumps + small API reconciliation. Confirm exact signatures against the ttoss changelog at implementation time.
- **Per-resource code stays.** Extractions target the generic engine/infrastructure only; SOAT business logic (lib modules, route actions, permission action names, formation resource modules) remains in SOAT.

## 8. Appendix

### 8.1 Referenced ttoss PRs (closed/merged)

| PR | Title |
|---|---|
| #1094 | feat(auth-core): add `createRedirectConsentOnAuthorize` and Postgres consent store |
| #1093 | feat(components): add `OAuthConsent` component with hierarchical scope support |
| #1091 | feat(http-server-mcp): support root mounting and fix protected-resource metadata resource URL |
| #1090 | fix(http-server-auth, http-server-mcp): accept `scopes[]` and warn on missing scope claim |
| #1089 | feat(http-server-serverless): add AWS Lambda adapter that populates rawHeaders |
| #1087 | feat(react-dashboard): composable filters, sx passthrough, type fix, conditional divider |
| #1080 | feat(react-notifications): add actions support and render as buttons |
| #1076 | fix(components): remove redundant nav element from Menu |
| #1074 | feat(oauth-client): add reusable third-party OAuth client package |
| #1070 | refactor: consolidate OAuth into `@ttoss/http-server-auth`, remove http-server-oauth |
| #1069 | refactor(auth): runner-agnostic OAuth core + http-server adapter, with guidelines |
| #1068 | feat(http-server-mcp): public MCP methods and RFC 9728 discovery in `createMcpRouter` |
| #1061 | feat(http-server-auth): pass `ctx` to auth callbacks + MCP OAuth guideline |
| #1059 | feat(http-server-mcp): add OAuth 2.1 Authorization Server primitives for MCP |
| #1047 | feat(auth-core, http-server-mcp): OAuth 2.1 primitives + standalone RFC 9728 discovery middleware |
| #1045 | feat(auth-core): add OAuth 2.1 authorization-server primitives |
| #1038 | feat(@ttoss/http-server-auth): add authentication middleware package |
| #1035 | feat(@ttoss/auth-core): add JWT, one-time token, and API token primitives |
| #1025 | feat(http-server): re-export Context, Next, and Middleware types from koa |
| #1016 | feat(@ttoss/http-server-mcp): add OAuth/JWT authentication support |
| #1015 | docs(@ttoss/layouts): add Sidebar displayName example and full component table |

### 8.2 SOAT's current `@ttoss/*` versions (for bump planning)

| Package | Pinned in SOAT |
|---|---|
| `@ttoss/auth-core` | `^0.7.0` |
| `@ttoss/http-server` | `^0.5.17` |
| `@ttoss/http-server-auth` | `^0.3.3` |
| `@ttoss/http-server-mcp` | `^0.13.3` |
| `@ttoss/postgresdb` | `^0.9.6` |
| `@ttoss/logger` (cli) | `^0.8.16` |

### 8.3 Key SOAT files referenced

- OAuth: `packages/server/src/oauth/server.ts`, `packages/server/src/lib/oauthConsent.ts`, `packages/server/src/rest/v1/oauth.ts`
- MCP: `packages/server/src/mcp/server.ts`, `packages/server/src/lib/soatTools.ts`, `soatToolsHelpers.ts`, `soatToolsSchemaHelpers.ts`
- IAM: `packages/server/src/lib/iam.ts`, `policyCompiler.ts`, `permissions.ts`, `permissionCatalog.ts`
- Case transform: `packages/server/src/middleware/caseTransform.ts`
- OpenAPI merge: `packages/server/src/lib/openapiSpec.ts`, `packages/sdk/scripts/generate.ts`
- CLI gen: `packages/cli/scripts/generate.ts`, `packages/cli/src/index.ts`
- App engine: `packages/app/src/engine/*`
- Formations: `packages/server/src/lib/formations*.ts`, `packages/server/src/lib/formation-modules/*`
- Docs gen: `packages/website/scripts/generate*.ts`
