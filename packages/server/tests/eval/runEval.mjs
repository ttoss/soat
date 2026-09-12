#!/usr/bin/env node
/**
 * `eval:knowledge` — the retrieval eval's one command.
 *
 * A wrapper rather than a bare `jest --projects tests/eval` because Jest
 * rejects any CLI option it does not define, and `--update-baseline` is the
 * eval's own. The flag is translated to an environment variable here; every
 * other argument is handed to Jest untouched.
 */
import { spawnSync } from 'node:child_process';

const UPDATE_BASELINE_FLAG = '--update-baseline';

const args = process.argv.slice(2);
const updateBaseline = args.includes(UPDATE_BASELINE_FLAG);

const result = spawnSync(
  'jest',
  [
    '--projects',
    'tests/eval',
    ...args.filter((arg) => {
      return arg !== UPDATE_BASELINE_FLAG;
    }),
  ],
  {
    stdio: 'inherit',
    env: updateBaseline
      ? { ...process.env, SOAT_EVAL_UPDATE_BASELINE: '1' }
      : process.env,
  }
);

if (result.error) throw result.error;

process.exit(result.status ?? 1);
