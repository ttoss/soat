import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ERROR_CODES } from '../../packages/server/src/errors/codes.ts';
import {
  declaredErrorCodes,
  declareInSpec,
  routeErrorCodes,
  specDir,
  specFiles,
} from './routeErrorCodes.mjs';

/**
 * Each operation's `x-raises` lists every code its route's handlers can
 * raise, derived from the source: a code a lib starts raising is declared on
 * every route that reaches it, or this fails. Rewrite the lists with
 * `pnpm declare-error-codes`.
 */

const absent = ({ codes, from }) => {
  return codes.filter((code) => {
    return !from.includes(code);
  });
};

/** `key: label CODE` for each of `codes` missing `from`. */
const report = ({ key, label, codes, from }) => {
  return absent({ codes, from }).map((code) => {
    return `${key}: ${label}${code}`;
  });
};

describe('route error code declaration', () => {
  const reached = routeErrorCodes();

  test('the scan follows a route into the libs it calls', () => {
    const expected = {
      'post /api/v1/agents/{agent_id}/generate': [
        'AI_PROVIDER_ERROR',
        'IDEMPOTENCY_KEY_REUSED',
        'MODEL_NOT_OFFERED',
        'MODEL_NOT_PRICED',
      ],
      'post /api/v1/chat/completions': [
        'MODEL_NOT_OFFERED',
        'MODEL_NOT_PRICED',
      ],
      'post /api/v1/model-routes': ['MODEL_NOT_OFFERED'],
      'get /api/v1/agents/{agent_id}': ['RESOURCE_NOT_FOUND'],
    };
    for (const [key, codes] of Object.entries(expected)) {
      assert.deepEqual(
        absent({ codes, from: reached.get(key) ?? [] }),
        [],
        key
      );
    }
  });

  test('the scan follows a re-export to the file declaring it', () => {
    // `rest/v1/tasks.ts` imports `transitionTask` through `lib/tasks.ts`.
    const key = 'post /api/v1/tasks/{task_id}/transitions';
    assert.deepEqual(
      absent({
        codes: ['TASK_GUARD_REJECTED', 'TASK_TRANSITION_CONFLICT'],
        from: reached.get(key) ?? [],
      }),
      [],
      key
    );
  });

  test('a detached async call raises nothing to its caller', () => {
    // `dispatchOnEnter` runs the on_enter automation detached, behind `.catch`.
    const key = 'post /api/v1/tasks/{task_id}/transitions';
    assert.ok(!(reached.get(key) ?? []).includes('AI_PROVIDER_ERROR'), key);
  });

  test('every code a route reaches is a registered code', () => {
    const unknown = [...reached].flatMap(([key, codes]) => {
      return report({ key, label: '', codes, from: Object.keys(ERROR_CODES) });
    });
    assert.deepEqual(unknown, []);
  });

  test('every operation declares exactly the codes its route reaches', () => {
    const drift = [...declaredErrorCodes()].flatMap(([key, declared]) => {
      const codes = reached.get(key) ?? [];
      return [
        ...report({ key, label: 'undeclared ', codes, from: declared }),
        ...report({ key, label: 'unreached ', codes: declared, from: codes }),
      ];
    });
    assert.deepEqual(drift, [], 'run `pnpm declare-error-codes`');
  });

  test('each spec is as `pnpm declare-error-codes` writes it', () => {
    const codesOf = (key) => {
      return reached.get(key);
    };
    const unwritten = specFiles().filter((file) => {
      const text = fs.readFileSync(path.join(specDir, file), 'utf8');
      return declareInSpec({ text, codesOf }) !== text;
    });
    assert.deepEqual(unwritten, []);
  });
});
