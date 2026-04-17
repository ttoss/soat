---
applyTo: '**'
description: Instructions for writing, running, and maintaining unit tests across the codebase.
---

# Test Instructions

## Running Tests

Run all tests for a package from the repo root:

```bash
pnpm --filter @soat/server test
```

Run tests for a specific file using `--testPathPatterns` (plural):

```bash
pnpm --filter @soat/server test --testPathPatterns=users.test.ts
```

## Test File Location and Naming

- Server unit tests live in `packages/server/tests/unit/tests/`
- Test file name must match the module: `<module>.test.ts` (e.g., `projects.test.ts`)
- Every public lib function and every REST route must have at least one test

## Test Infrastructure

Tests are integration tests that run against `app.callback()` via supertest. A real PostgreSQL instance is spun up via testcontainers, configured in `setupTestsAfterEnv.ts`. No mocking of the database layer is needed.

### Helpers (from `tests/unit/testClient.ts`)

- `testClient` — unauthenticated supertest client
- `authenticatedTestClient(token)` — returns a client that sets `Authorization: Bearer <token>` on every request
- `loginAs(username, password)` — bootstrap helper that logs in and returns the token string

For API key authentication, pass the raw `SDK_`-prefixed key directly to `authenticatedTestClient`.

## Writing Unit Tests

### Structure

Group tests by HTTP method and route path using nested `describe` blocks:

```ts
describe('MyModule', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'alice', password: 'alicepass' });

    userToken = await loginAs('alice', 'alicepass');
  });

  describe('GET /api/v1/resource', () => {
    test('authenticated user can list resources', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/resource');
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/resource');
      expect(response.status).toBe(401);
    });
  });
});
```

### Coverage Requirements

Every module must cover:

- Happy path for each route (correct status code and response shape)
- `401` for unauthenticated requests
- `403` for requests by users without required permission
- Edge cases specific to the business logic (e.g., API key scoping, missing resources returning `404`)

### Response Shape Assertions

Always assert the shape of the response body, not just the status code:

```ts
expect(response.body.id).toBeDefined();
expect(response.body.name).toBe('expected name');
expect(response.body.password).toBeUndefined(); // sensitive fields must be absent
```

Internal database IDs must never appear in responses — assert `id` maps to `publicId`.

## MCP Tool Tests

All MCP (Model Context Protocol) tools must be tested in `packages/server/tests/unit/tests/mcp.test.ts`. This is a single integration test file that covers all MCP tools across all modules.

### When to Add MCP Tests

**Every new MCP tool must have a corresponding test added to `mcp.test.ts` before the implementation is considered complete.** This includes:

- New tools added to existing modules
- New modules with MCP tools
- Modifications to existing tools that change their behavior

### Test Structure

MCP tests are organized by module with comment headers:

```ts
// ── Module Name ──────────────────────────────────────────────────────────

test('tool-name does something', async () => {
  const res = await mcpCall('tool-name', { arg: 'value' });
  expect(res.status).toBe(200);
  const result = parseResult(res);
  expect(result.id).toBeDefined();
});
```

### Test Patterns

- Use the `mcpCall` helper to invoke tools via the MCP endpoint
- Use `parseResult` to extract JSON responses
- Assert both HTTP status codes and response structure
- Follow the same coverage requirements as REST API tests (happy path, error cases)
- Mock external service responses (e.g., AI completions) to ensure tests are deterministic and fast

### Running MCP Tests

Run MCP tests specifically:

```bash
pnpm --filter @soat/server test --testPathPatterns=mcp.test.ts
```

## Smoke Test

The smoke test (`tests/smoke-test.sh`) is an end-to-end shell script that runs against a live server. It requires `curl` and `jq`.

### Running

```bash
pnpm run -w smoke-test
```

The script uses `set -e` and exits with a non-zero code on the first failure, printing which step failed.

### Scope

The smoke test must cover every module end-to-end: users, projects, project policies, project keys, secrets, files, documents, conversations, chats, AI providers, agents (HTTP tool, MCP tool, client tool, SOAT tool), and traces. Every new module must have corresponding smoke test steps added before the implementation is considered done.

### Environment Variables

`docker-compose.test.yml` must include every environment variable that the server requires at runtime for the features under test. Missing variables cause hard startup failures. Key variables:

- `SECRETS_ENCRYPTION_KEY` — 64-character hex string (32 bytes) required by the secrets module. Use a fixed test value: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`.

Whenever a new env-dependent feature is added to the server, add the corresponding variable to the `server` service environment in `docker-compose.test.yml` at the same time.

### Prerequisites and Ordering

Some endpoints require prior setup that is not performed automatically. Always satisfy prerequisites explicitly in the smoke script before calling the endpoint:

- **Project keys** — `POST /project-keys` requires the calling user to be a member of the project (`UserProject` row). Add the user via `POST /projects/:id/members` (expect `201`) before creating a key.
- **Secrets** — require `SECRETS_ENCRYPTION_KEY` to be set in the server environment.

### Agent and LLM Smoke Patterns

- **Do not assert LLM output content.** Only check structural/status fields (e.g., `status == "completed"`, `id` is present). LLM responses vary by model and prompt.
- **Poll for async generation.** Agent generation endpoints may return `in_progress`; retry with a loop and `--max-time` guard before asserting the final status.
- **Client-tool (`requires_action`) flow.** When testing client-side tool execution: assert `status == "requires_action"`, extract `requiredAction.toolCalls[0]`, submit a synthetic result to `POST /agents/:id/generate/:genId/tool-outputs`, then assert `status == "completed"`.
- **Non-fatal server errors from LLM tool calls** (e.g., `SequelizeValidationError` when the model hallucinates a bad tool argument) do not fail the smoke test — only the smoke assertions matter.
