import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `assertCredentialProjectScope` answers a mis-scoped credential with an
 * `API_KEY_PROJECT_SCOPE` error naming both projects and the remedy, rather
 * than an opaque `{"error":"Forbidden"}`. It runs only inside
 * `resolveProjectIdsWithAction` and `resolveWriteProjectId`.
 *
 * A route that names a project and skips those helpers answers the identical
 * condition with the bare `Forbidden`, so the diagnostic a caller gets would be
 * decided by which helper a handler happened to call.
 *
 * A route that calls `authUser.resolveProjectIds` **with** a `projectPublicId`
 * has, by definition, a requested project to diagnose, and is therefore the
 * shape that must go through the helper. A call without one is the item-scoped
 * path — it names no project, so there is nothing to report — and is not
 * flagged.
 *
 * Static because the failure is a *worse error message*, not a wrong status: no
 * success path changes, so a new handler can reintroduce the opaque form and
 * every one of its own tests will still pass. This check is what makes the
 * correct path mandatory rather than merely available — which matters most
 * where routes converge on a shared preamble, since the risk there is 21 routes
 * landing on whichever helper a refactor happens to pick.
 */

const ROUTES_DIR = join(__dirname, '../../../../src/rest/v1');

/** Index just past the bracket that opens at `openIndex`. */
const matchClose = (text: string, openIndex: number): number => {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if ('({['.includes(char)) depth += 1;
    else if (')}]'.includes(char)) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('unbalanced brackets');
};

test('a route that names a project resolves it through the scope-checking helper', () => {
  const offenders: string[] = [];

  for (const entry of readdirSync(ROUTES_DIR)) {
    // `helpers.ts` is where the checked call lives.
    if (!entry.endsWith('.ts') || entry === 'helpers.ts') continue;

    const source = readFileSync(join(ROUTES_DIR, entry), 'utf-8');
    const pattern = /resolveProjectIds\(\{/g;
    let match = pattern.exec(source);
    while (match) {
      const objectStart = match.index + match[0].length - 1;
      const argument = source.slice(
        objectStart,
        matchClose(source, objectStart)
      );
      if (argument.includes('projectPublicId')) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${entry}:${line}`);
      }
      match = pattern.exec(source);
    }
  }

  expect(offenders).toEqual([]);
});
