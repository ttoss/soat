import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * A container started per suite multiplies by the Jest workers, and under CI
 * load testcontainers' reaper lock then fails whole suites. A container is
 * started once per run, in a Jest `globalSetup` its config names.
 */
const CONTAINER_IMPORT =
  /(?:import\s+(?!type\b)[^;]*?from\s+|import\()\s*'(?:@testcontainers\/[\w-]+|testcontainers)'/;

const trackedSources = () => {
  return execFileSync('git', ['ls-files', 'packages/*.ts', 'packages/*.mts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
};

const globalSetupOf = (file) => {
  const config = path.join(path.dirname(file), 'jest.config.ts');
  const source = fs.existsSync(path.join(repoRoot, config))
    ? fs.readFileSync(path.join(repoRoot, config), 'utf8')
    : '';
  const match = source.match(/globalSetup:\s*'<rootDir>\/([^']+)'/);
  return match && path.join(path.dirname(file), match[1]);
};

describe('test containers', () => {
  test('only a jest globalSetup starts one', () => {
    const starters = trackedSources().filter((file) => {
      return CONTAINER_IMPORT.test(
        fs.readFileSync(path.join(repoRoot, file), 'utf8')
      );
    });

    assert.ok(starters.length > 0, 'no container starter found');

    const strays = starters.filter((file) => {
      return globalSetupOf(file) !== file;
    });

    assert.deepEqual(strays, []);
  });
});
