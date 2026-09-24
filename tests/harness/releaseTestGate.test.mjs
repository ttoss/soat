import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  classifyReleaseDiff,
  evaluatePrRunJobs,
  runGate,
} from '../../scripts/releaseTestGate.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const MAIN_WORKFLOW = readFileSync(
  `${ROOT}.github/workflows/main.yml`,
  'utf-8'
);

/** A `git diff -U0` section for one file. */
const fileDiff = (args) => {
  return [
    `diff --git a/${args.path} b/${args.path}`,
    'index 1111111..2222222 100644',
    `--- a/${args.path}`,
    `+++ b/${args.path}`,
    '@@ -3 +3 @@',
    ...args.lines,
  ].join('\n');
};

const versionBump = (path) => {
  return fileDiff({
    path,
    lines: ['-  "version": "0.58.5",', '+  "version": "0.58.6",'],
  });
};

const RELEASE_NAME_STATUS = [
  'M\tCHANGELOG.md',
  'M\tlerna.json',
  'M\tpackages/sdk/CHANGELOG.md',
  'M\tpackages/sdk/package.json',
].join('\n');

const RELEASE_DIFF = [
  fileDiff({ path: 'CHANGELOG.md', lines: ['+## 0.58.6', '+', '+- fix'] }),
  versionBump('lerna.json'),
  fileDiff({ path: 'packages/sdk/CHANGELOG.md', lines: ['+## 0.58.6'] }),
  versionBump('packages/sdk/package.json'),
].join('\n');

describe('classifyReleaseDiff', () => {
  test('accepts version bumps and changelog entries', () => {
    const result = classifyReleaseDiff({
      nameStatus: RELEASE_NAME_STATUS,
      diff: RELEASE_DIFF,
    });

    assert.equal(result.ok, true, result.reason);
  });

  test('accepts a changelog created by a package first release', () => {
    const result = classifyReleaseDiff({
      nameStatus: 'A\tpackages/new/CHANGELOG.md',
      diff: fileDiff({ path: 'packages/new/CHANGELOG.md', lines: ['+# x'] }),
    });

    assert.equal(result.ok, true, result.reason);
  });

  test('rejects any file outside the release allowlist', () => {
    const result = classifyReleaseDiff({
      nameStatus: `${RELEASE_NAME_STATUS}\nM\tpnpm-lock.yaml`,
      diff: RELEASE_DIFF,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /pnpm-lock\.yaml/);
  });

  test('rejects a package.json change beyond its version field', () => {
    const result = classifyReleaseDiff({
      nameStatus: 'M\tpackages/sdk/package.json',
      diff: fileDiff({
        path: 'packages/sdk/package.json',
        lines: [
          '-  "version": "0.58.5",',
          '+  "version": "0.58.6",',
          '+    "left-pad": "^1.0.0",',
        ],
      }),
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /left-pad/);
  });

  test('rejects a package.json that is added or deleted', () => {
    for (const status of ['A', 'D']) {
      const result = classifyReleaseDiff({
        nameStatus: `${status}\tpackages/new/package.json`,
        diff: '',
      });

      assert.equal(result.ok, false, status);
    }
  });

  test('rejects an empty diff', () => {
    const result = classifyReleaseDiff({ nameStatus: '', diff: '' });

    assert.equal(result.ok, false);
  });
});

describe('evaluatePrRunJobs', () => {
  test('passes when every job succeeded', () => {
    const result = evaluatePrRunJobs({
      jobs: [
        { name: 'Detect Changes', conclusion: 'success' },
        { name: 'Tutorials Tests', conclusion: 'success' },
      ],
    });

    assert.equal(result.ok, true, result.reason);
  });

  test('fails when a job was skipped, as on a Markdown-only PR', () => {
    const result = evaluatePrRunJobs({
      jobs: [
        { name: 'Detect Changes', conclusion: 'success' },
        { name: 'Tutorials Tests', conclusion: 'skipped' },
      ],
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /Tutorials Tests/);
  });

  test('fails with no jobs', () => {
    assert.equal(evaluatePrRunJobs({ jobs: [] }).ok, false);
  });
});

/**
 * Fakes for `git` and `gh`: `git` answers by its first argument, `gh` by the
 * API path, so each test states only what differs from a clean release.
 */
const fakes = (overrides = {}) => {
  const tree = overrides.tree ?? 'tree-tested';
  const git = (args) => {
    if (args[0] === 'rev-parse') {
      return args[1].endsWith('^{tree}') ? 'tree-tested' : 'parent';
    }
    if (args.includes('--name-status')) return RELEASE_NAME_STATUS;
    return RELEASE_DIFF;
  };
  const api = {
    'repos/o/r/commits/parent/pulls': overrides.pulls ?? [
      { number: 7, merge_commit_sha: 'parent', head: { sha: 'head' } },
    ],
    'repos/o/r/commits/head': { commit: { tree: { sha: tree } } },
    'repos/o/r/actions/workflows/pr.yml/runs?head_sha=head&event=pull_request&status=success&per_page=100':
      { workflow_runs: overrides.runs ?? [{ id: 1, run_attempt: 1 }] },
    'repos/o/r/actions/runs/1/jobs?filter=latest&per_page=100': {
      jobs: overrides.jobs ?? [{ name: 'Tests', conclusion: 'success' }],
    },
  };
  const gh = (path) => {
    if (!(path in api)) throw new Error(`unexpected gh call: ${path}`);
    return api[path];
  };

  return { git, gh, repo: 'o/r', head: 'release' };
};

describe('runGate', () => {
  test('reports tested when the parent tree passed every PR job', () => {
    const result = runGate(fakes());

    assert.equal(result.tested, true, result.reason);
  });

  test('re-tests when the PR head tree differs from the parent tree', () => {
    // The PR merged while behind main: main holds code no PR run saw.
    const result = runGate(fakes({ tree: 'tree-other' }));

    assert.equal(result.tested, false);
    assert.match(result.reason, /tree/);
  });

  test('re-tests when the parent commit came from no pull request', () => {
    const result = runGate(fakes({ pulls: [] }));

    assert.equal(result.tested, false);
  });

  test('re-tests when the PR has no successful run', () => {
    const result = runGate(fakes({ runs: [] }));

    assert.equal(result.tested, false);
  });

  test('re-tests when a PR job was skipped', () => {
    const result = runGate(
      fakes({ jobs: [{ name: 'Smoke Tests', conclusion: 'skipped' }] })
    );

    assert.equal(result.tested, false);
  });

  test('re-tests instead of failing when an API call throws', () => {
    const args = fakes();
    const result = runGate({
      ...args,
      gh: () => {
        throw new Error('HTTP 502');
      },
    });

    assert.equal(result.tested, false);
    assert.match(result.reason, /HTTP 502/);
  });
});

describe('main.yml wiring', () => {
  const jobBlock = (name) => {
    const match = MAIN_WORKFLOW.match(
      new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`)
    );
    assert.ok(match, `job ${name} not found`);
    return match[1];
  };

  test('every test job runs unless the gate proved the tree tested', () => {
    for (const job of ['build-and-test', 'smoke-test', 'tutorials-test']) {
      const block = jobBlock(job);

      assert.match(block, /needs: release-test-gate/, job);
      assert.match(
        block,
        /if: needs\.release-test-gate\.outputs\.tested != 'true'/,
        job
      );
    }
  });

  test('the release tag waits on the gate and blocks on any test failure', () => {
    const block = jobBlock('push-release-tag');

    assert.match(
      block,
      /needs: \[release-test-gate, build-and-test, smoke-test, tutorials-test\]/
    );
    assert.match(block, /needs\.release-test-gate\.result == 'success'/);
    assert.match(block, /!contains\(needs\.\*\.result, 'failure'\)/);
    assert.match(block, /!contains\(needs\.\*\.result, 'cancelled'\)/);
  });

  /**
   * The implicit `success()` reads every ancestor, so a job downstream of the
   * tag inherits the skipped test jobs and is skipped with them. Each one has
   * to state its condition on the tag job alone.
   */
  test('every job after the tag runs whenever the tag was pushed', () => {
    for (const job of ['release', 'publish-docker']) {
      const block = jobBlock(job);

      assert.match(block, /needs: push-release-tag/, job);
      assert.match(block, /!cancelled\(\)/, job);
      assert.match(block, /needs\.push-release-tag\.result == 'success'/, job);
    }
  });
});
