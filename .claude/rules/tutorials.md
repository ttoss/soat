---
paths:
  - "packages/website/docs/tutorials/**"
---

# Tutorial Instructions

Tutorials demonstrate real SOAT workflows end-to-end. Every tutorial must be fully validated against a live dev server before it is published. The CLI is the primary validation tool — it calls the SDK, which calls the REST API, so a passing CLI run validates all three layers simultaneously.

## Authoring Rules

- **One Docusaurus file per tutorial** under `packages/website/docs/tutorials/`. Set `sidebar_position` in the front matter.
- **Three-tab pattern for every code block**: `CLI` (default), `SDK`, `curl`. Use `<Tabs groupId="client">` so all code blocks on the page switch together.
- **Prerequisites section must not include installation or bootstrap steps** — assume the reader has already installed SOAT and bootstrapped their first admin. Link to the relevant docs instead. (Note: when running the dev server locally, SOAT_ADMIN credentials are already defined in `.env`, so the first admin account exists automatically.)
- **Prerequisite env-var block** must export the correct values per client:
  - CLI tab: `export SOAT_BASE_URL=http://localhost:5047` (the CLI and SDK append `/api/v1/...` route paths internally — do NOT include `/api/v1`)
  - curl tab: `export SOAT_BASE_URL=http://localhost:5047` (curl examples append the full path manually, e.g. `$SOAT_BASE_URL/api/v1/users/login`)
  - SDK tab: `new SoatClient({ baseUrl: 'http://localhost:5047', token: '...' })` (do NOT include `/api/v1` — the SDK appends route paths itself)
- **Write steps in order**. Number them `Step 1`, `Step 2`, … Use sub-steps (e.g. `### 3a`, `### 3b`) only when a single logical step has multiple variants.
- **Cross-link to module docs at the point where a concept is first introduced**. Add a brief inline sentence linking to the relevant module page (e.g. [IAM](/docs/modules/iam), [Policies](/docs/modules/policies)) so readers can look up details without leaving the tutorial flow. Only link once per concept — do not repeat the same link in every step.
- **Every step must reference at least one doc**. Each `## Step N` section must contain an inline link to either a SOAT module doc (`/docs/modules/<module>`) or a relevant third-party doc (e.g. [Ollama](https://ollama.com), [OpenAI](https://platform.openai.com/docs)). Steps that introduce a new resource must link to its module page; steps that only operate on an already-introduced resource may link to a specific subsection anchor (e.g. `[Sessions — Async Generation](/docs/modules/sessions#async-generation)`).
- **Testable tutorials that create a local AI provider must hint at third-party alternatives**. Any step that creates a local Ollama-backed AI provider (for automated test compatibility) must include a sentence pointing readers to the [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms) tutorial. Example: "This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms)."
- **Prerequisites must reference the getting-started docs**. Always include:
  - [Quick Start](/docs/getting-started) — for readers who need to bring the stack up.
  - [Key Concepts](/docs/getting-started/concepts) — for readers new to SOAT's mental model.
  - [Advanced Configuration](/docs/getting-started/advanced-config) — for readers who need production hardening (secrets, env vars).
    Link to third-party installation docs (e.g. [Ollama](https://ollama.com), [Docker](https://docs.docker.com/get-docker/)) when the tutorial depends on external tooling.

## Reading the Docs Locally

After running `pnpm run build` in `packages/website`, the full rendered documentation is available under `packages/website/build/docs/`. Use those local files instead of fetching from `https://soat.ttoss.dev`.

The index of all available doc pages is at `packages/website/build/llms.txt`. Each entry maps a URL like `https://soat.ttoss.dev/docs/modules/files.md` to the local file `packages/website/build/docs/modules/files.md` — drop the `https://soat.ttoss.dev/` prefix to get the relative path.

Examples:

| URL in llms.txt                                        | Local file                                             |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `https://soat.ttoss.dev/docs/modules/files.md`         | `packages/website/build/docs/modules/files.md`         |
| `https://soat.ttoss.dev/docs/modules/iam.md`           | `packages/website/build/docs/modules/iam.md`           |
| `https://soat.ttoss.dev/docs/tutorials/permissions.md` | `packages/website/build/docs/tutorials/permissions.md` |

Always run `pnpm run build` in `packages/website` first to ensure the local docs are up to date before reading them.

## OpenAPI Is the Source of Truth

Before writing any command in a tutorial, read the OpenAPI spec for that resource: `packages/server/src/rest/openapi/v1/<resource>.yaml`.

Key things to verify:

- **Exact field names**: REST bodies use `snake_case` (e.g. `project_id`, `policy_ids`). Path parameters use `camelCase` in the URL template (e.g. `{userId}`, `{policyId}`).
- **Action strings**: IAM action strings (e.g. `files:GetFile`, `files:UploadFile`) must exactly match what the server handler passes to `compilePolicy`. Read the handler file (`packages/server/src/rest/v1/<resource>.ts`) and grep for `action:` to find the canonical names.
- **Correct HTTP verbs**: Check the spec for `GET/POST/PUT/DELETE`. Do not guess — e.g. attaching user policies is `PUT /users/{userId}/policies`, not `POST`.
- **Required vs optional fields**: Note which body fields are `required` in the spec.

### CLI Flag Naming

The CLI derives flag names from the OpenAPI path-parameter names and body field names:

- Path params (camelCase in spec) become `--kebab-case` flags: `userId` → `--user-id`, `policyId` → `--policy-id`.
- Body fields (snake_case in spec) become `--kebab-case` flags: `project_id` → `--project-id`, `policy_ids` → `--policy-ids`.

Cross-check the generated route definition in `packages/cli/src/generated/routes.ts` to confirm `pathParams` for every command.

### SDK Field Naming

The SDK is generated from the OpenAPI spec. Body fields match the OpenAPI spec (snake_case). Path params match the URL template (camelCase). Example:

```ts
// Correct — body uses snake_case, path uses camelCase
await adminSoat.users.attachUserPolicies({
  path: { user_id: alice.id },
  body: { policy_ids: [FULL_POLICY_ID] },
});
```

Note: the SDK client accessor is `adminSoat.<module>.<operation>(...)`. Path params in `params.path` also use snake_case to match the URL template.

### Shell Quoting in CLI Tutorials

The automated tutorial runner (`tests/tutorials-tests.sh`) extracts commands only from `<TabItem value="cli">` fenced bash blocks and replays them in a single shell context. It handles multi-line continuation via `_sq_open()` — a line accumulator that counts single quotes and continues while the count is odd. **Double-quoted multi-line strings are NOT handled**; do not spread a double-quoted string across lines.

**Rules for JSON arguments in CLI commands:**

1. **Always use single-quoted JSON** for `--document`, `--preset-parameters`, `--actions`, `--policy-ids`, and any other flag that takes a JSON value:

   ```bash
   soat create-policy --document '{"statement":[...]}'
   ```

2. **Variable interpolation inside single-quoted JSON** uses the `'"$VAR"'` pattern — close the single-quote, double-quote the variable, reopen single-quote:

   ```bash
   soat create-agent-tool --preset-parameters '{"documentId": "'"$PUBLIC_DOC_ID"'"}'
   soat attach-user-policies --policy-ids '["'"$POLICY_ID"'"]'
   ```

3. **Multi-line single-quoted JSON is supported** by the runner because it counts unclosed single quotes:
   ```bash
   POLICY_ID=$(soat create-policy \
     --name "my-policy" \
     --document '{
   "statement": [
     {"effect": "Allow", "action": ["agents:CreateAgentGeneration"]}
   ]
   }' | jq -r '.id')
   ```

### SRN Format in Policy Documents

SRN (SOAT Resource Name) values in policy `resource` arrays must follow exactly this format:

```
soat:<projectId>:<resourceType>:<resourceId>
```

- Exactly **4 colon-separated segments** — validated by `/^soat:[^:]+:[^:]+:[^:]+$/`.
- `<resourceType>` is the **singular** resource name: `document`, `file`, `agent`, etc. (not `documents`, `files`).
- `<resourceId>` can be an ID (`doc_xxx`) or a path (`/notes/public/note.txt`). Paths with a leading `/` are valid because they contain no colons.
- Wildcards use `*`: `soat:proj_xxx:document:/notes/public/*` matches all documents under that path.
- In CLI single-quoted JSON, interpolate the project ID as `'"$PROJECT_ID"'`:
  ```bash
  "resource": ["soat:'"$PROJECT_ID"':document:/notes/public/*"]
  ```

Common wrong formats:

| Wrong                                             | Correct                                     |
| ------------------------------------------------- | ------------------------------------------- |
| `srn::$PROJECT_ID:documents:path:/notes/public/*` | `soat:$PROJECT_ID:document:/notes/public/*` |
| `soat:$PROJECT_ID:documents:/notes/public/*`      | `soat:$PROJECT_ID:document:/notes/public/*` |
| `soat:$PROJECT_ID:document:path:/notes/public/*`  | `soat:$PROJECT_ID:document:/notes/public/*` |

## Validation Workflow

**Validate using the CLI only.** The CLI calls the SDK, which calls the REST API, so a passing CLI run validates all three layers simultaneously. There is no need to separately test SDK or curl examples if the CLI succeeds.

### 1. Start the dev stack

From the `packages/server` directory:

```bash
pnpm run db-dev:start   # start the database container
pnpm run dev            # start the server in watch mode
```

Other useful commands:

```bash
pnpm run db-dev:stop    # stop the database container
pnpm run db-dev:rm      # stop and remove the database volume
```

Wait until `http://localhost:5047/health` returns `{"status":"ok"}`. The first admin account (username: `admin`, password: `Admin1234!`) is automatically available from the `.env` file — no bootstrap step needed.

### 2. Set environment variables

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1
```

### 3. Run every CLI command in order

Execute each CLI snippet from the tutorial top to bottom in a single shell session, substituting real IDs returned by earlier steps. A CLI command that fails immediately reveals an SDK or REST bug. Fix the root cause before updating the tutorial. (CLI validation proves REST and SDK correctness because the CLI calls the SDK, which calls the REST API.)

Example session pattern:

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

ALICE_ID=$(soat create-user --username alice --password Alice1234! | jq -r '.id')

PROJECT_ID=$(soat create-project --name Analytics | jq -r '.id')

POLICY_ID=$(soat create-policy \
  --name "analytics-full-access" \
  --document "$(cat /tmp/policy.json)" | jq -r '.id')

soat attach-user-policies --user-id "$ALICE_ID" --policy-ids '["'"$POLICY_ID"'"]'
```

A CLI command that fails immediately reveals an SDK or REST bug. Fix the root cause before updating the tutorial.

### 4. Run the automated tutorial test

Before checking the build, run the tutorial through the containerised test runner to catch shell-quoting bugs, SRN format errors, and wrong CLI flags that only show up at runtime:

```bash
TUTORIAL_ID=<tutorial-name> docker compose -f tests/docker-compose.tutorials.yml \
  up --build --renew-anon-volumes --remove-orphans \
  --abort-on-container-exit --exit-code-from tutorials 2>&1 | tee /tmp/tutorial_run.log | tail -60
```

`<tutorial-name>` is the filename without `.md` (e.g. `agent-soat-tools` for `agent-soat-tools.md`). The runner exits 0 on success and prints `✅ <name> passed` / `❌ <name> FAILED`.

To capture full output for debugging without terminal truncation:

```bash
grep "tutorials-1\|server-1" /tmp/tutorial_run.log
```

### 5. Check the build

After the tutorial test passes, verify Docusaurus renders it without errors:

```bash
cd packages/website && pnpm run build
```

Fix all warnings and errors before committing.

## Fixing Errors Found During Validation

When a CLI command fails:

1. **Check the OpenAPI spec** — confirm the path, method, and body fields are correct.
2. **Check the CLI routes file** (`packages/cli/src/generated/routes.ts`) — confirm path params and query params.
3. **Run curl directly** to isolate whether the issue is the server or the CLI/SDK layer.
4. **Fix the source, not just the tutorial**:
   - If the spec is wrong: update the YAML in `packages/server/src/rest/openapi/v1/`.
   - If the handler is wrong: update `packages/server/src/rest/v1/<resource>.ts` and `packages/server/src/lib/<resource>.ts`.
   - If the spec or any server code changed: rebuild the CLI with `pnpm turbo run build --filter @soat/cli`. Because the CLI package is linked, the `soat` command is updated automatically — no reinstall needed.
   - Then update the tutorial to reflect the correct command.
5. **Add a regression test**: if validation exposes a server bug, add a test to `packages/server/tests/unit/tests/rest/permissionsFlow.test.ts` (or the relevant module test file) that would have caught the bug. The test should fail on the unfixed code and pass after the fix.

### Common Mistakes

| Mistake                                   | Correct approach                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Using `files:ListFiles` as an action      | Use `files:GetFile` — the server uses the same action for both listing and getting                                                                                                             |
| Using POST for policy attachment          | It is `PUT /users/{userId}/policies` (replaces entire list)                                                                                                                                    |
| `--id` for user-scoped commands           | Use `--user-id` (path param is `userId`)                                                                                                                                                       |
| `baseUrl: 'http://localhost:5047/api/v1'` in SDK | Must be `baseUrl: 'http://localhost:5047'` — the SDK appends `/api/v1/...` paths itself; including it doubles the prefix |
| `SOAT_URL=http://localhost:5047` for CLI         | Use `SOAT_BASE_URL=http://localhost:5047` (no `/api/v1`)                                                                 |
| Shell quoting mixed IDs in policy JSON    | Use single-quoted JSON with `'"$VAR"'` interpolation: `--document '{"key": "'"$VAR"'"}'`. The tutorial runner does not handle double-quoted multi-line strings.                                |
| Omitting `resource` in policy documents   | Always include `"resource": ["soat:$PROJECT_ID:*:*"]` for project-scoped examples. Omitting it defaults to `["*"]` (all projects), which masks scoping bugs and is rarely the tutorial intent. |
| Wrong SRN format in policy resource       | Must be `soat:<projectId>:<singularType>:<id-or-path>` — exactly 4 colon-separated segments. Wrong: `srn::`, `documents:path:`, 5 segments with `path:` infix.                                 |
| `--provider` vs `--type` for AI providers | The flag is `--provider` (maps to body field `provider`). There is no `--type` flag. Similarly, `--default-model` not `--model`.                                                               |
| Using wrong Ollama model name             | The docker-compose test stack only pulls `qwen2.5:0.5b`. Use that exact string; `qwen2.5:0.5b` and other variants are not available in CI.                                                       |
| `attachUserPolicy` (singular)             | The operation is `attachUserPolicies` (plural) with path param `user_id` and body `policy_ids` (array). CLI: `soat attach-user-policies --user-id "$ID" --policy-ids '["'"$PID"'"]'`           |

## Tutorial Checklist

Before opening a PR with a new or updated tutorial:

- [ ] Every CLI command runs successfully against a live dev server
- [ ] IDs in example output are real (copy-pasted from an actual run), not invented
- [ ] Step numbering is consistent (no skipped or duplicated numbers)
- [ ] All three tabs (CLI, SDK, curl) have working examples — CLI validation proves correctness
- [ ] `pnpm run build` in `packages/website` passes without errors or warnings
- [ ] Action names in policy documents match what the server handler actually checks
- [ ] SDK `baseUrl` is the server host only, e.g. `http://localhost:5047` — no `/api/v1`
- [ ] CLI and curl prerequisites export `SOAT_BASE_URL` (not `SOAT_URL`), no `/api/v1`
- [ ] JSON CLI arguments use single-quoted strings with `'"$VAR"'` for variable interpolation
- [ ] SRN values follow `soat:<projectId>:<singularType>:<id-or-path>` — exactly 4 colon-separated segments
- [ ] Automated tutorial test (`TUTORIAL_ID=<name> docker compose ...`) passes with exit code 0
- [ ] Every step has at least one inline link to a SOAT module doc or relevant third-party doc
