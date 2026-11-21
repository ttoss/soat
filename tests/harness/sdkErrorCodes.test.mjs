import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import { sdkErrorCodes } from '../../packages/sdk/scripts/errorCodes.ts';
import { ERROR_CODES } from '../../packages/server/src/errors/codes.ts';

/**
 * `@soat/sdk` exports the server's `ERROR_CODES` as code → `httpStatus`,
 * generated from the server registry at build so a consumer never transcribes
 * a status by hand.
 */

const read = (relativePath) => {
  return fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), {
    encoding: 'utf8',
  });
};

describe('SDK ERROR_CODES export', () => {
  test('carries every server code with its status', () => {
    const expected = Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, { httpStatus }]) => {
        return [code, { httpStatus }];
      })
    );
    assert.deepEqual(sdkErrorCodes({ codes: ERROR_CODES }), expected);
  });

  test('the SDK generate step writes it', () => {
    assert.match(read('packages/sdk/scripts/generate.ts'), /writeErrorCodes\(/);
  });

  test('the SDK entry point exports it', () => {
    assert.match(
      read('packages/sdk/src/index.ts'),
      /export \{ ERROR_CODES, type ErrorCode \} from '\.\/generated\/errorCodes\.js';/
    );
  });
});
