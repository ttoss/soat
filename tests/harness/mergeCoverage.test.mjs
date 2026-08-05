import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  evaluateThresholds,
  mergeCoverage,
} from '../../scripts/mergeCoverage.mjs';

/**
 * Minimal Istanbul file-coverage object: one entry in `s` per statement, keyed
 * by the same ids as `statementMap`. `hits` is the per-statement hit count, so
 * `[1, 0]` is "two statements, the second uncovered".
 */
const fileCoverage = (args) => {
  const statementMap = {};
  const s = {};

  for (const [index, hit] of args.hits.entries()) {
    statementMap[index] = {
      start: { line: index + 1, column: 0 },
      end: { line: index + 1, column: 10 },
    };
    s[index] = hit;
  }

  return {
    path: args.path,
    statementMap,
    s,
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
};

describe('mergeCoverage', () => {
  test('sums hit counts for a file that several shards touched', () => {
    // The whole point of sharding: no single shard sees full coverage of a
    // file, but the union does.
    const shardA = {
      '/repo/src/a.ts': fileCoverage({ path: '/repo/src/a.ts', hits: [1, 0] }),
    };
    const shardB = {
      '/repo/src/a.ts': fileCoverage({ path: '/repo/src/a.ts', hits: [0, 3] }),
    };

    const merged = mergeCoverage({ coverages: [shardA, shardB] });

    assert.deepEqual(merged.fileCoverageFor('/repo/src/a.ts').s, {
      0: 1,
      1: 3,
    });
    assert.equal(
      merged.fileCoverageFor('/repo/src/a.ts').toSummary().statements.pct,
      100
    );
  });

  test('keeps files that only one shard reported', () => {
    const shardA = {
      '/repo/src/a.ts': fileCoverage({ path: '/repo/src/a.ts', hits: [1] }),
    };
    const shardB = {
      '/repo/src/b.ts': fileCoverage({ path: '/repo/src/b.ts', hits: [1] }),
    };

    const merged = mergeCoverage({ coverages: [shardA, shardB] });

    assert.deepEqual(merged.files().sort(), [
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
  });
});

describe('evaluateThresholds', () => {
  let cwd;

  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-coverage-'));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(cwd, 'src', 'b.ts'), '');
  });

  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const mapOf = (files) => {
    const coverage = {};
    for (const [name, hits] of Object.entries(files)) {
      const filePath = path.join(cwd, 'src', name);
      coverage[filePath] = fileCoverage({ path: filePath, hits });
    }
    return mergeCoverage({ coverages: [coverage] });
  };

  test('passes when the global aggregate clears the bar', () => {
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1, 1, 1, 1], 'b.ts': [1, 1, 1, 0] }),
      coverageThreshold: { global: { statements: 80 } },
      cwd,
    });

    assert.deepEqual(errors, []);
  });

  test('fails with the metric and both percentages when the global aggregate misses', () => {
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1, 0, 0, 0] }),
      coverageThreshold: { global: { statements: 80 } },
      cwd,
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /statements \(25%\)/);
    assert.match(errors[0], /"global" threshold \(80%\)/);
  });

  test('aggregates the global group across every covered file', () => {
    // 4 of 8 statements covered — each file alone would pass a 50% bar only by
    // accident; the aggregate is what the threshold is about.
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1, 1, 1, 1], 'b.ts': [0, 0, 0, 0] }),
      coverageThreshold: { global: { statements: 60 } },
      cwd,
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /statements \(50%\)/);
  });

  test('checks a glob group per file and names only the file below the bar', () => {
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1, 1, 1, 1], 'b.ts': [1, 0, 0, 0] }),
      coverageThreshold: { './src/**/*.ts': { statements: 75 } },
      cwd,
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /b\.ts/);
    assert.doesNotMatch(errors[0], /a\.ts/);
  });

  test('still aggregates global over all files when a glob group claimed them', () => {
    // Jest sorts a file into the glob group *instead of* global, then falls
    // back to every covered file for the global aggregate. Getting this wrong
    // would silently drop the global gate entirely.
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1, 0, 0, 0] }),
      coverageThreshold: {
        global: { statements: 80 },
        './src/**/*.ts': { statements: 10 },
      },
      cwd,
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /"global" threshold \(80%\)/);
  });

  test('reads a negative threshold as a maximum uncovered count', () => {
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1, 0, 0, 0] }),
      coverageThreshold: { global: { statements: -2 } },
      cwd,
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Uncovered count for statements \(3\)/);
  });

  test('accepts a threshold group that no file matches only when it is global', () => {
    const errors = evaluateThresholds({
      coverageMap: mapOf({ 'a.ts': [1] }),
      coverageThreshold: { './lib/**/*.ts': { statements: 50 } },
      cwd,
    });

    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /Coverage data for \.\/lib\/\*\*\/\*\.ts was not found/
    );
  });
});
