/**
 * Decide whether a release commit on `main` needs the test suite again.
 *
 * `pr.yml` skips every job on a `chore(release):` PR, so `main.yml` used to
 * re-run the whole suite on the release commit — code whose PR had gone green
 * a minute earlier, plus version bumps. This gate skips that re-run only when
 * it can prove both halves:
 *
 *   1. the release commit changes nothing but `version` fields, `lerna.json`
 *      and changelogs, and
 *   2. its parent's exact tree is the head of a PR whose latest `pr.yml` run
 *      passed with every job succeeding — none skipped.
 *
 * (2) compares trees, not commits: a squash merge makes a new commit, but its
 * tree equals the PR head's only when the PR was up to date with `main`. A PR
 * that merged while behind puts code on `main` that no PR run saw, and a
 * Markdown-only PR skips the test jobs, so both fall back to the full suite.
 * So does any error: the gate can only ever skip tests, never fail a release.
 *
 * `tests/harness/releaseTestGate.test.mjs` pins these rules.
 *
 * Usage (in CI, with GH_TOKEN set):
 *   node scripts/releaseTestGate.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHANGELOG = /(^|\/)CHANGELOG\.md$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const VERSION_LINE = /^[+-]\s*"version":\s*"[^"]*",?\s*$/;

/** Changed lines per file from `git diff -U0` output. */
const changedLinesByFile = (diff) => {
  const files = new Map();
  let current;

  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/.+ b\/(.+)$/);

    if (header) {
      current = header[1];
      files.set(current, []);
      continue;
    }

    if (current === undefined) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      files.get(current).push(line);
    }
  }

  return files;
};

/** Why one changed file is not a release file, or `undefined` if it is. */
const rejectEntry = (args) => {
  const { status, path, lines } = args;

  if (CHANGELOG.test(path)) {
    return status === 'M' || status === 'A'
      ? undefined
      : `${path} has status ${status}`;
  }

  if (path !== 'lerna.json' && !PACKAGE_JSON.test(path)) {
    return `${path} is not a release file`;
  }

  if (status !== 'M') {
    return `${path} has status ${status}`;
  }

  const other = lines.find((line) => {
    return !VERSION_LINE.test(line);
  });

  return other === undefined
    ? undefined
    : `${path} changes more than its version: ${other}`;
};

/**
 * Whether a diff is only what `lerna version` writes: modified `version`
 * fields in `package.json` / `lerna.json`, and changelogs.
 */
export const classifyReleaseDiff = (args) => {
  const entries = args.nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status, path };
    });

  if (entries.length === 0) {
    return { ok: false, reason: 'the release commit changes no files' };
  }

  const changedLines = changedLinesByFile(args.diff);

  for (const { status, path } of entries) {
    const reason = rejectEntry({
      status,
      path,
      lines: changedLines.get(path) ?? [],
    });

    if (reason !== undefined) return { ok: false, reason };
  }

  return { ok: true, reason: 'only versions and changelogs change' };
};

/** Whether a PR run's jobs all succeeded — a skipped job tested nothing. */
export const evaluatePrRunJobs = (args) => {
  if (args.jobs.length === 0) {
    return { ok: false, reason: 'the PR run has no jobs' };
  }

  const notPassed = args.jobs.filter((job) => {
    return job.conclusion !== 'success';
  });

  if (notPassed.length > 0) {
    const list = notPassed
      .map((job) => {
        return `${job.name} (${job.conclusion})`;
      })
      .join(', ');
    return { ok: false, reason: `PR jobs did not all succeed: ${list}` };
  }

  return { ok: true, reason: `all ${args.jobs.length} PR jobs succeeded` };
};

const decide = (args) => {
  const { git, gh, repo, head } = args;
  const parent = git(['rev-parse', `${head}~1`]);

  const diff = classifyReleaseDiff({
    nameStatus: git(['diff', '--name-status', '--no-renames', parent, head]),
    diff: git(['diff', '-U0', '--no-color', '--no-ext-diff', parent, head]),
  });

  if (!diff.ok) return { tested: false, reason: diff.reason };

  const pull = gh(`repos/${repo}/commits/${parent}/pulls`).find((pr) => {
    return pr.merge_commit_sha === parent;
  });

  if (!pull) {
    return { tested: false, reason: `${parent} was not merged from a PR` };
  }

  const parentTree = git(['rev-parse', `${parent}^{tree}`]);
  const headTree = gh(`repos/${repo}/commits/${pull.head.sha}`).commit.tree.sha;

  if (parentTree !== headTree) {
    return {
      tested: false,
      reason: `#${pull.number} head tree ${headTree} differs from main's ${parentTree} — it merged behind main`,
    };
  }

  const { workflow_runs: runs } = gh(
    `repos/${repo}/actions/workflows/pr.yml/runs?head_sha=${pull.head.sha}&event=pull_request&status=success&per_page=100`
  );

  if (runs.length === 0) {
    return {
      tested: false,
      reason: `#${pull.number} has no successful PR run`,
    };
  }

  const { jobs } = gh(
    `repos/${repo}/actions/runs/${runs[0].id}/jobs?filter=latest&per_page=100`
  );
  const verdict = evaluatePrRunJobs({ jobs });

  if (!verdict.ok) return { tested: false, reason: verdict.reason };

  return {
    tested: true,
    reason: `#${pull.number} tested this exact tree (run ${runs[0].id}): ${verdict.reason}`,
  };
};

/** The gate's verdict. Never throws: an error means "run the tests". */
export const runGate = (args) => {
  try {
    return decide(args);
  } catch (error) {
    return {
      tested: false,
      reason: `gate error, running tests: ${error.message}`,
    };
  }
};

const main = () => {
  const run = (command, commandArgs) => {
    return execFileSync(command, commandArgs, { encoding: 'utf-8' }).trim();
  };

  const result = runGate({
    git: (gitArgs) => {
      return run('git', gitArgs);
    },
    gh: (path) => {
      return JSON.parse(run('gh', ['api', path]));
    },
    repo: process.env.GITHUB_REPOSITORY,
    head: 'HEAD',
  });

  process.stdout.write(`tested=${result.tested}: ${result.reason}\n`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tested=${result.tested}\n`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const verdict = result.tested
      ? 'Skipping the test jobs'
      : 'Running the test jobs';
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release test gate\n\n${verdict}: ${result.reason}\n`
    );
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
