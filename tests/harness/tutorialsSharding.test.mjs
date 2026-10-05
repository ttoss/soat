import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runTutorials = path.join(repoRoot, 'tests/run-tutorials.sh');

/**
 * The tutorials job runs as a matrix, each shard picking its slice of the
 * sorted list. A slice rule that drops or doubles a tutorial is invisible in
 * CI — every shard is green — so this pins the union and the disjointness.
 *
 * The script lists what it will run before it bootstraps the admin user; the
 * base URL here refuses the connection, so the run stops right after the list.
 */
const listed = (args) => {
  const result = spawnSync('bash', [runTutorials], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      SOAT_BASE_URL: 'http://127.0.0.1:9',
      TUTORIALS_DIR: args.dir,
      IGNORE_FILE: args.ignoreFile,
      TUTORIAL_SHARD: args.shard,
      TUTORIAL_ID: '',
    },
  });
  const names = result.stdout
    .split('\n')
    .filter((line) => {
      return line.startsWith('  - ');
    })
    .map((line) => {
      return line.slice(4).replace(/\.md$/, '');
    });
  return { names, status: result.status, stdout: result.stdout };
};

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorials-'));
  for (const name of [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
  ]) {
    fs.writeFileSync(path.join(dir, `${name}.md`), '# t\n');
  }
  const ignoreFile = path.join(dir, '.tutorialsignore');
  fs.writeFileSync(ignoreFile, '# skipped\ndelta\n');
  return { dir, ignoreFile };
};

describe('tutorials sharding', () => {
  test('the shards are disjoint and together run every tutorial not ignored', () => {
    const { dir, ignoreFile } = fixture();
    const first = listed({ dir, ignoreFile, shard: '1/2' }).names;
    const second = listed({ dir, ignoreFile, shard: '2/2' }).names;

    assert.deepEqual(
      first.filter((name) => {
        return second.includes(name);
      }),
      []
    );
    assert.deepEqual([...first, ...second].sort(), [
      'alpha',
      'bravo',
      'charlie',
      'echo',
      'foxtrot',
      'golf',
    ]);
    assert.ok(Math.abs(first.length - second.length) <= 1);
  });

  test('without a shard, the whole list runs', () => {
    const { dir, ignoreFile } = fixture();
    const unsharded = listed({ dir, ignoreFile, shard: '' }).names;

    assert.equal(unsharded.length, 6);
  });

  test('a malformed shard is refused rather than running everything', () => {
    const { dir, ignoreFile } = fixture();
    for (const shard of ['3/2', '0/2', 'two', '1/0']) {
      const result = listed({ dir, ignoreFile, shard });

      assert.notEqual(result.status, 0, shard);
      assert.deepEqual(result.names, [], shard);
    }
  });
});
