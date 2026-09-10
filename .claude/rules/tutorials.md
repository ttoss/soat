---
paths:
  - "packages/website/docs/tutorials/**"
---

# Tutorials

Every tutorial is validated end-to-end against a live dev server via the CLI
(which exercises the SDK and REST beneath it) before publishing.

## Authoring

- One Docusaurus file per tutorial in `packages/website/docs/tutorials/`, with
  `sidebar_position`.
- Every code block: `<Tabs groupId="client">` with `CLI` (default), `SDK`,
  `curl`.
- Prerequisites link to [Quick Start](/docs/getting-started),
  [Key Concepts](/docs/getting-started/concepts),
  [Configuration](/docs/self-hosting/configuration) and any third-party tooling;
  no install or bootstrap steps (the dev `.env` already defines the admin).
- Env block: `export SOAT_BASE_URL=http://localhost:5047` for CLI and curl;
  `new SoatClient({ baseUrl: 'http://localhost:5047', token })` for the SDK.
  Never append `/api/v1`; never `SOAT_URL`.
- Numbered `## Step N`; sub-steps `### 3a` only for variants.
- Prose between blocks follows `website.md` **Prose**: one or two sentences
  saying what the step does and linking its doc; no commentary on the output
  beyond the fields the next step reads.
- Every step links at least one doc (`/docs/modules/<module>`, a subsection
  anchor, or a third-party doc). Link a concept once, where it is introduced.
- A step creating a local Ollama provider points to
  [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

## Read the spec first

`packages/server/src/rest/openapi/v1/<resource>.yaml` decides field names
(snake_case bodies), verbs, required fields. IAM action strings must match the
handler's `action:` in `packages/server/src/rest/v1/<resource>.ts`. CLI flags
are kebab-case of the spec names (`project_id` → `--project-id`); confirm in
`packages/cli/src/generated/routes.ts`. SDK: `soat.<module>.<operation>({ path,
body })`, snake_case throughout.

## Shell quoting (the runner replays CLI blocks)

`tests/tutorials-tests.sh` extracts `<TabItem value="cli">` bash blocks and
joins multi-line commands by counting single quotes. Double-quoted multi-line
strings are not handled.

- JSON arguments are single-quoted: `--document '{"statement":[...]}'`.
- Interpolate with `'"$VAR"'`: `--policy-ids '["'"$POLICY_ID"'"]'`.
- Multi-line single-quoted JSON is fine.

## SRN format

`soat:<projectId>:<resourceType>:<resourceId>` — exactly 4 colon-separated
segments (`/^soat:[^:]+:[^:]+:[^:]+$/`), singular type (`document`, not
`documents`), id or path (`/notes/public/*`), `*` wildcards. In CLI JSON:
`"soat:'"$PROJECT_ID"':document:/notes/public/*"`. Always include `resource` in
project-scoped examples; omitting it means `["*"]`.

## Validation

```bash
# packages/server
pnpm run db-dev:start && pnpm run dev      # until /health → {"status":"ok"}; admin / Admin1234!
export SOAT_BASE_URL=http://localhost:5047
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
# run every CLI snippet top to bottom in one shell

TUTORIAL_ID=<name> docker compose -f tests/docker-compose.tutorials.yml \
  up --build --renew-anon-volumes --remove-orphans \
  --abort-on-container-exit --exit-code-from tutorials 2>&1 | tee /tmp/tutorial_run.log | tail -60

cd packages/website && pnpm run build      # no warnings or errors
```

Local rendered docs: `packages/website/build/docs/` after the build; index in
`packages/website/build/llms.txt` (drop the `https://soat.ttoss.dev/` prefix).

A failing command reveals a spec, handler, SDK or CLI bug: fix the source
(rebuild the CLI with `pnpm turbo run build --filter @soat/cli`), add a
regression test (`tests/unit/tests/rest/permissionsFlow.test.ts` or the module
file), then update the tutorial.

## Common mistakes

| Wrong | Right |
|---|---|
| `files:ListFiles` | `files:GetFile` covers list and get |
| `POST` to attach policies | `PUT /users/{userId}/policies` (replaces the list) |
| `--id` on user commands | `--user-id` |
| `baseUrl: 'http://localhost:5047/api/v1'` | `baseUrl: 'http://localhost:5047'` |
| `--type` / `--model` for AI providers | `--provider` / `--default-model` |
| any other Ollama model | `qwen2.5:0.5b` (the only one CI pulls) |
| `attachUserPolicy` | `attachUserPolicies` (`user_id`, `policy_ids` array) |

## Checklist

- [ ] Every CLI command ran against a live server; output ids are real
- [ ] Step numbering consistent; every step links a doc
- [ ] CLI, SDK, curl tabs present
- [ ] `SOAT_BASE_URL` without `/api/v1`; SDK `baseUrl` is the host only
- [ ] Single-quoted JSON with `'"$VAR"'`; SRNs have 4 segments
- [ ] Action names match the handler
- [ ] Tutorial runner exits 0; `pnpm run build` clean
