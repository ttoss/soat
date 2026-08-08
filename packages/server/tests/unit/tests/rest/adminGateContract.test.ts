import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `requireAdmin` exists because a bare `ctx.authUser.role !== 'admin'`
 * comparison bypasses `isAllowed`/`resolveProjectIds`, and therefore bypasses
 * `recordAuthorizationDecision` — so a route built on the bare comparison makes
 * an authorization decision that nothing downstream can see (#745).
 *
 * `policies.ts` and `users.ts` both *imported* `requireAdmin`, used it on their
 * write routes, and hand-rolled the comparison on their reads (#905). That
 * within-file split is what made the helper look optional to the next reader,
 * and it is the reason this check is static: the two forms return the same
 * status for the same caller, so every behavioural test of those routes passed
 * either way.
 *
 * Only the *gate* shape is flagged — a role comparison that answers `403`. A
 * role comparison that selects a broader query instead (`apiKeys.ts` showing an
 * admin every key rather than only their own) decides scope, not access, and is
 * deliberately left alone.
 */

const ROUTES_DIR = join(__dirname, '../../../../src/rest/v1');

/** A role comparison, and the `403` it answers with, within a few lines. */
const HAND_ROLLED_GATE =
  /role\s*!==\s*'admin'[\s\S]{0,120}?ctx\.status = 403/g;

test('no route hand-rolls the admin gate', () => {
  const offenders: string[] = [];

  for (const entry of readdirSync(ROUTES_DIR)) {
    // `helpers.ts` is where the gate — and its audit record — lives.
    if (!entry.endsWith('.ts') || entry === 'helpers.ts') continue;

    const source = readFileSync(join(ROUTES_DIR, entry), 'utf-8');
    for (const match of source.matchAll(HAND_ROLLED_GATE)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${entry}:${line}`);
    }
  }

  expect(offenders).toEqual([]);
});
