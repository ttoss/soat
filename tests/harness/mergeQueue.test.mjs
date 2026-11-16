import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * `main` lands through a merge queue whose required check is
 * `All Checks Passed`, so `pr.yml` runs on the queue's `merge_group` branch
 * too. There a PR's paths and head ref do not exist: every test job runs and
 * nothing deploys.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
const PR_WORKFLOW = readFileSync(`${ROOT}.github/workflows/pr.yml`, 'utf-8');

/** Each step of the workflow, as its text. */
const steps = PR_WORKFLOW.split(/\n(?= {6}- )/).slice(1);

describe('pr.yml under the merge queue', () => {
  test('runs on merge_group', () => {
    assert.match(PR_WORKFLOW, /\non:\n(?: {2}\S.*\n)*? {2}merge_group:/);
  });

  test('every step reading the PR head ref runs on pull_request only', () => {
    const unguarded = steps.filter((step) => {
      return (
        step.includes('github.event.pull_request.head') &&
        !/\n {8}if: github\.event_name == 'pull_request'\n/.test(step)
      );
    });
    assert.deepEqual(unguarded, []);
  });

  test('the paths filter is not what runs the tests in the queue', () => {
    assert.match(
      PR_WORKFLOW,
      /code: \$\{\{ github\.event_name == 'merge_group' \|\| steps\.filter\.outputs\.code \}\}/
    );
  });
});
