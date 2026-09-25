import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * A `chore(release):` PR skips every build and test job, so the one thing
 * `main.yml` needs from it before tagging — a lockfile a frozen install
 * accepts — is checked by a job of its own, and `All Checks Passed` waits on
 * it. `lerna version` rewrites the lockfile, which is how one can arrive broken.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
const PR_WORKFLOW = readFileSync(`${ROOT}.github/workflows/pr.yml`, 'utf-8');

/** The text of one top-level job, from its key to the next job's. */
const jobBlock = (name) => {
  const start = PR_WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `pr.yml has no \`${name}\` job`);
  const rest = PR_WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('release PR lockfile guard', () => {
  test('runs a frozen install on release PRs only', () => {
    const job = jobBlock('release-lockfile');
    assert.match(
      job,
      /if: "startsWith\(github\.event\.pull_request\.title, 'chore\(release\):'\)"/
    );
    assert.match(job, /run: pnpm install --frozen-lockfile/);
  });

  test('gates All Checks Passed', () => {
    const job = jobBlock('all-checks');
    assert.match(job, /needs:[\s\S]*- release-lockfile/);
    assert.match(job, /\$\{\{ needs\.release-lockfile\.result \}\}/);
  });
});
