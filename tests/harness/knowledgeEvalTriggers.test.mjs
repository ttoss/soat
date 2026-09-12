import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ROOT = new URL('../..', import.meta.url).pathname;
const WORKFLOW = readFileSync(`${ROOT}.github/workflows/pr.yml`, 'utf-8');
const GOLDEN_PATH = 'packages/server/tests/eval/knowledge/golden.json';

/**
 * The retrieval eval seeds part of its corpus from the module docs, so editing
 * one of those sections moves the numbers. `changes` filters on `!**` + `/*.md`,
 * so a Markdown-only PR reports `code: false` and skips the eval — and
 * `main.yml` has no eval job to catch it afterwards. The drift would land
 * silently and fail the next unrelated code PR.
 *
 * These lock the two halves that keep that from happening: the fixtures stay
 * inside one directory, and the job triggers on that directory.
 */

/** Every `source` the golden set seeds from a doc. */
const citedSources = () => {
  const golden = JSON.parse(readFileSync(`${ROOT}${GOLDEN_PATH}`, 'utf-8'));
  const sources = new Set();

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (typeof node.source === 'string') sources.add(node.source);
    for (const value of Object.values(node)) walk(value);
  };

  walk(golden.corpus);
  return [...sources];
};

/** The `changes` job's paths-filter block as `{ output: [pattern] }`. */
const changeFilters = () => {
  const block = WORKFLOW.match(/^ {10}filters: \|\n((?: {12}.*\n|\n)+)/m);
  assert.ok(block, 'the changes job declares a `filters: |` block');

  const filters = {};
  let current = null;

  for (const line of block[1].split('\n')) {
    const name = line.match(/^ {12}([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (name) {
      current = name[1];
      filters[current] = [];
      continue;
    }
    const pattern = line.match(/^ {14}- '(.*)'\s*$/);
    if (pattern && current) filters[current].push(pattern[1]);
  }

  return filters;
};

/** The outputs the knowledge-eval job's `if:` consults. */
const evalTriggerOutputs = () => {
  const job = WORKFLOW.match(
    /^ {2}knowledge-eval:\n((?: {4}.*\n|\n)+?)^ {4}steps:/m
  );
  assert.ok(job, 'pr.yml declares a knowledge-eval job');

  const condition = job[1].match(/^ {4}if: (.*)$/m);
  assert.ok(condition, 'the knowledge-eval job has an `if:` condition');

  return [
    ...condition[1].matchAll(/needs\.changes\.outputs\.([A-Za-z0-9_]+)/g),
  ].map((match) => {
    return match[1];
  });
};

/** A paths-filter glob as a regex. A negation never makes a path trigger. */
const globMatches = (args) => {
  if (args.pattern.startsWith('!')) return false;

  const source = args.pattern
    .split('**')
    .map((part) => {
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    })
    .join('.*');

  return new RegExp(`^${source}$`).test(args.path);
};

/** The cited sources no pattern gating the eval job would match. */
const unguardedSources = (args) => {
  return args.sources.filter((path) => {
    return !args.gating.some((pattern) => {
      return globMatches({ pattern, path });
    });
  });
};

describe('knowledge eval CI triggers', () => {
  test('every doc-seeded fixture lives under the module docs directory', () => {
    const stray = citedSources().filter((source) => {
      return !source.startsWith('packages/website/docs/modules/');
    });

    assert.deepEqual(
      stray,
      [],
      'a fixture outside packages/website/docs/modules/ escapes the CI filter'
    );
  });

  test('a change to any cited doc triggers the knowledge-eval job', () => {
    const filters = changeFilters();
    const gating = evalTriggerOutputs().flatMap((output) => {
      return filters[output] ?? [];
    });

    const unguarded = unguardedSources({ sources: citedSources(), gating });

    assert.deepEqual(
      unguarded,
      [],
      `editing these skips the eval; gating patterns: ${JSON.stringify(gating)}`
    );
  });
});

describe('knowledge eval artifacts', () => {
  test('the generated report is gitignored', () => {
    const report = 'packages/server/tests/eval/knowledge/report.json';

    const ignored = (() => {
      try {
        execFileSync('git', ['check-ignore', report], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    })();

    assert.ok(ignored, `${report} is written by every local eval run`);
  });
});
