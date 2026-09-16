import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.claude/rules/errors.md` states the rule in prose:
 *
 * > **Do not set `ctx.body = { error: '...' }` manually** — throw `DomainError`
 * > with the appropriate code instead.
 *
 * Prose is the bottom of the durability ladder, and it lost: 349 manual bodies
 * across 44 files accumulated against it, and the split ran *inside* single
 * files — a missing webhook answered `{"error":"Webhook not found"}` while a
 * missing delivery in the same module answered
 * `{"error":{"code":"RESOURCE_NOT_FOUND",…}}`. Every client, the SDK and the CLI
 * had to handle both shapes for the same condition (#913).
 *
 * This test is the deterministic replacement. It is static because the failure
 * is a *shape*, not a status: a route that answers `404` with a bare string
 * passes any test that only asserts `response.status`, which is exactly how the
 * drift stayed invisible.
 *
 * The same argument covers the auth/scope preamble (#908). `checkAuth` and the
 * eight `check*Access` clones each re-implemented `401`/`403` by hand, and each
 * copy was free to pick a different error body — that substrate is what let 21
 * of 25 read routes miss the actionable scoped-key `403`. With the preamble in
 * one helper, an inline `!ctx.authUser` in a route is by definition a route that
 * opted out of it, so it is banned outright rather than merely discouraged.
 */

const V1_DIR = join(__dirname, '../../../../src/rest/v1');
const ERROR_LOGGER = join(
  __dirname,
  '../../../../src/middleware/errorLogger.ts'
);

/**
 * Handlers throw `DomainError`; the middleware owns the response body.
 *
 * Matched across lines because five of the original bodies wrapped — a
 * single-line check would have called the file clean and left the shape split.
 */
const MANUAL_ERROR_BODY = /ctx\.body\s*=\s*\{\s*error:/;

/**
 * The auth preamble lives in `helpers.ts`; a route must not re-derive it.
 *
 * `!ctx.authUser.apiKeyProjectId` is a different question — whether the
 * credential is project-scoped — so the negation only counts when nothing is
 * read off it.
 */
const INLINE_AUTH_CHECK = /!\s*ctx\.authUser\b(?!\s*[.!])/;

/**
 * The scope half of the same preamble. Calling `resolveProjectIds` directly
 * skips `assertCredentialProjectScope` and leaves the caller to hand-write the
 * `null` (and sometimes the empty-array) rejection — the 26 copies of that
 * decision are what made `resolveReadProjectIds` and `requireProjectAccess`
 * disagree route by route.
 */
const DIRECT_SCOPE_RESOLUTION = /\bauthUser!?\.resolveProjectIds\(/;

/**
 * The modules allowed to read `ctx.authUser` for a guard — they *are* the
 * shared preamble: `helpers.ts` owns the project-level half, `resourceAccess.ts`
 * the per-resource half an item route uses instead (#1339). Both may still not
 * write a manual error body.
 */
const PREAMBLE_OWNERS = ['helpers.ts', 'resourceAccess.ts'];

/** `router.get('/path', …)` — the start of one route's handler. */
const ROUTE_REGISTRATION = /\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;

/**
 * A project-level scope resolution: the helper *plus* the `resourceType` that
 * turns its probe into `srn:<project>:<type>:*`.
 *
 * `[^}]*` deliberately does not cross a nested brace — every call site passes a
 * flat argument object, and a match that walked into a nested one would start
 * reporting the next statement's keys.
 */
const PROJECT_LEVEL_SCOPE =
  /\b(requireProjectAccess|resolveReadProjectIds)\(\{[^}]*\bresourceType:/;

/**
 * The registration's own closing line, at column 0 — `});` for the one-line
 * form, `);` for the wrapped one.
 *
 * Bounding the body here rather than at the next registration is what keeps a
 * helper *defined between two routes* out of the preceding route's source:
 * `chats.ts` declares `requireStatelessCompletionAccess` after its `DELETE`
 * handler, and attributing that helper's project-level check to the delete
 * route would report a hole the route does not have.
 */
const HANDLER_END = /^\)?\}?\);$/;

/** One entry per route registered in a file, with the source it owns. */
const routeHandlers = (
  source: string
): { method: string; path: string; line: number; body: string }[] => {
  const lines = source.split('\n');

  return [...source.matchAll(ROUTE_REGISTRATION)].map((match) => {
    const startLine = source.slice(0, match.index).split('\n').length - 1;
    const endLine = lines.findIndex((line, index) => {
      return index > startLine && HANDLER_END.test(line);
    });

    return {
      method: match[1],
      path: match[2],
      line: startLine + 1,
      body: lines
        .slice(startLine, endLine === -1 ? lines.length : endLine + 1)
        .join('\n'),
    };
  });
};

/** `/tools/:tool_id`, `/evals/:eval_id/runs` — a path that names one resource. */
const namesAResource = (path: string): boolean => {
  return /\/:\w+_id\b/.test(path);
};

/**
 * Blanks comments while preserving offsets, so a rule quoted in a doc comment —
 * as `helpers.ts` quotes the ❌ example it exists to replace — is not read as an
 * instance of it.
 */
const stripComments = (source: string): string => {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
};

/** Line numbers where `pattern` matches, scanning the whole source at once. */
const scan = (rawSource: string, pattern: RegExp) => {
  const source = stripComments(rawSource);
  const all = new RegExp(pattern.source, `${pattern.flags}gs`);
  const found: { line: number }[] = [];

  let match: RegExpExecArray | null;

  while ((match = all.exec(source)) !== null) {
    found.push({ line: source.slice(0, match.index).split('\n').length });
  }

  return found;
};

/**
 * The middleware is the last place a string-shaped body could come back, and it
 * is the place it survived longest: #913 converged the 349 handler bodies but
 * left the 500 catch-all as `{ error: 'Internal Server Error' }`, so a client
 * still had to test the type of `error` before reading it.
 */
describe('the error middleware emits one shape', () => {
  test('assigns no bare-string error body', () => {
    const violations = scan(
      readFileSync(ERROR_LOGGER, 'utf8'),
      /ctx\.body\s*=\s*\{\s*error:\s*['`]/
    );

    expect(
      violations.map((v) => {
        return `errorLogger.ts:${v.line} returns a string error body — every response is { error: { code, message } }`;
      })
    ).toEqual([]);
  });
});

describe('REST handlers signal errors with DomainError', () => {
  const files = readdirSync(V1_DIR).filter((f) => {
    return f.endsWith('.ts');
  });

  test('every v1 handler file is scanned', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(files)('%s sets no manual error body', (file) => {
    const violations = scan(
      readFileSync(join(V1_DIR, file), 'utf8'),
      MANUAL_ERROR_BODY
    );

    expect(
      violations.map((v) => {
        return `${file}:${v.line} sets a manual error body — throw DomainError instead (.claude/rules/errors.md)`;
      })
    ).toEqual([]);
  });

  test.each(
    files.filter((f) => {
      return !PREAMBLE_OWNERS.includes(f);
    })
  )('%s does not re-derive the auth preamble', (file) => {
    const source = readFileSync(join(V1_DIR, file), 'utf8');

    const violations = [
      ...scan(source, INLINE_AUTH_CHECK).map((v) => {
        return `${file}:${v.line} checks \`ctx.authUser\` inline — use requireAuth / resolveReadProjectIds / resolveWriteProjectId from helpers.ts`;
      }),
      ...scan(source, DIRECT_SCOPE_RESOLUTION).map((v) => {
        return `${file}:${v.line} calls \`resolveProjectIds\` directly — use resolveReadProjectIds / requireProjectAccess / resolveWriteProjectId from helpers.ts`;
      }),
    ];

    expect(violations).toEqual([]);
  });
});

/**
 * The audit behind #1339 found twelve modules whose `/:x_id` routes authorized
 * with the project wildcard `srn:<project>:<type>:*` — a probe a statement
 * naming one resource can never match, so a policy scoped to one tool reached
 * *nothing* while an action-only one reached every sibling in the project.
 *
 * It was an audit finding because nothing failed: each route answered `200` for
 * the callers it was tested with, and the granularity it dropped is invisible
 * from a single response. This is the deterministic replacement — the same
 * argument that makes the error *shape* a static test rather than a status
 * assertion. A route that names a resource authorizes against that resource,
 * through `resourceAccess.ts`; reaching for a project-level helper there is now
 * a failing test rather than something an auditor has to rediscover.
 *
 * A listing (`GET /tools?project_id=`) and a create take no `:x_id`, so they
 * stay project-scoped and are untouched by this.
 */
describe('a route that names a resource authorizes against it', () => {
  const files = readdirSync(V1_DIR).filter((f) => {
    return f.endsWith('.ts');
  });

  test.each(files)('%s authorizes its item routes per resource', (file) => {
    const source = stripComments(readFileSync(join(V1_DIR, file), 'utf8'));

    const violations = routeHandlers(source)
      .filter((route) => {
        return (
          namesAResource(route.path) && PROJECT_LEVEL_SCOPE.test(route.body)
        );
      })
      .map((route) => {
        return (
          `${file}:${route.line} ${route.method.toUpperCase()} ${route.path} ` +
          `authorizes at project level — the probe is \`srn:<project>:<type>:*\`, ` +
          `which no statement naming one resource matches. Use ` +
          `authorizeResource from resourceAccess.ts (#1339)`
        );
      });

    expect(violations).toEqual([]);
  });
});
