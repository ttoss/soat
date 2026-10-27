import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every operation's spec carries the IAM action it is enforced with, so a
 * consumer reads operation and action in one place. `src/permissions/*.json`
 * stays the source; `x-iam-action` must equal its entry.
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');
const permissionsDir = path.join(serverRoot, 'src/permissions');

/** Operations no policy governs, so they carry no action. */
const PERMISSIONLESS_OPERATIONS = new Map([
  ['loginUser', 'unauthenticated: exchanges credentials for a token'],
  ['bootstrapUser', 'unauthenticated: creates the first admin'],
  ['getCurrentUser', 'self-scoped: reads the caller behind the token'],
  ['uploadFileWithToken', 'the upload token is the credential'],
  ['completeIngestionCallback', 'internal ingestion callback'],
  ['getOauthAuthorizationServerMetadata', 'public OAuth discovery'],
  ['getOauthProtectedResourceMetadata', 'public OAuth discovery'],
  ['registerOauthClient', 'OAuth dynamic client registration'],
  ['authorizeOauthClient', 'OAuth authorization endpoint'],
  ['createOauthToken', 'OAuth token endpoint'],
]);

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'];

const catalogActions = () => {
  const actions = new Map();
  for (const file of fs.readdirSync(permissionsDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const { operations } = JSON.parse(
      fs.readFileSync(path.join(permissionsDir, file), 'utf8')
    );
    for (const { operationId, action } of operations) {
      actions.set(operationId, action);
    }
  }
  return actions;
};

const specOperations = () => {
  return fs
    .readdirSync(specDir)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .sort()
    .flatMap((file) => {
      const spec = load(fs.readFileSync(path.join(specDir, file), 'utf8'));
      return Object.values(spec?.paths ?? {}).flatMap((item) => {
        return HTTP_METHODS.flatMap((method) => {
          const op = item?.[method];
          return op?.operationId ? [{ file, op }] : [];
        });
      });
    });
};

describe('x-iam-action', () => {
  const actions = catalogActions();
  const operations = specOperations();

  test('reads operations and actions from disk', () => {
    assert.ok(operations.length > 0);
    assert.ok(actions.size > 0);
  });

  test('every governed operation declares its catalog action', () => {
    const wrong = operations
      .filter(({ op }) => {
        return !PERMISSIONLESS_OPERATIONS.has(op.operationId);
      })
      .filter(({ op }) => {
        const expected = actions.get(op.operationId);
        return !expected || op['x-iam-action'] !== expected;
      })
      .map(({ file, op }) => {
        return `${file} ${op.operationId}: spec=${op['x-iam-action']} catalog=${actions.get(op.operationId)}`;
      });

    assert.deepEqual(wrong, []);
  });

  test('a permissionless operation declares no action', () => {
    const declared = operations
      .filter(({ op }) => {
        return (
          PERMISSIONLESS_OPERATIONS.has(op.operationId) &&
          (op['x-iam-action'] !== undefined || actions.has(op.operationId))
        );
      })
      .map(({ op }) => {
        return op.operationId;
      });

    assert.deepEqual(declared, []);
  });

  test('every permissionless entry names a real operation', () => {
    const ids = new Set(
      operations.map(({ op }) => {
        return op.operationId;
      })
    );
    const stale = [...PERMISSIONLESS_OPERATIONS.keys()].filter((id) => {
      return !ids.has(id);
    });

    assert.deepEqual(stale, []);
  });
});
