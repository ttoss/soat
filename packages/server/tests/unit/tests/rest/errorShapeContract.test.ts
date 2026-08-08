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
 * `helpers.ts` is the one place allowed to read `ctx.authUser` for a guard —
 * it *is* the shared preamble. It still may not write a manual error body.
 */
const PREAMBLE_OWNER = 'helpers.ts';

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
      return f !== PREAMBLE_OWNER;
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
