import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(
  new URL('../../packages/server/', import.meta.url)
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);

/**
 * A tool call is one request returning one result: a `202` it cannot poll
 * leaves an agent step or an orchestration `tool` node holding a record with
 * no answer in it. So every `wait` either carries `x-soat-tool-forced: 'true'`
 * or is named here, with the reason polling it is the point of the call
 * (`.claude/rules/sync-async.md`).
 */
const TOOL_CHOOSES_WAIT = {
  ingestDocument:
    'ingestion runs as long as the file takes to extract and embed',
  reingestDocument:
    'ingestion runs as long as the file takes to extract and embed',
  StartOrchestrationRunRequest: 'a run can pause on human input or run long',
  startEvalRun: 'a run scores a whole dataset',
};

/** The `wait` fields declared directly on `node`. */
const ownWaitFields = (node) => {
  const own = [];
  if (node.in === 'query' && node.name === 'wait') own.push(node);
  if (node.properties?.wait) own.push(node.properties.wait);
  return own;
};

const collectWaitFields = (node, owner, found) => {
  if (!node || typeof node !== 'object') return;
  const key = node.operationId ?? owner;
  for (const field of ownWaitFields(node)) found.push({ owner: key, field });
  for (const value of Object.values(node)) {
    collectWaitFields(value, key, found);
  }
};

/**
 * Every `wait` query parameter or body property, keyed by the operationId that
 * declares it, or by the component schema for a body written once and `$ref`d.
 */
const waitFields = () => {
  const found = [];
  const specs = fs
    .readdirSync(specDir)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .map((file) => {
      return load(fs.readFileSync(path.join(specDir, file), 'utf8'));
    });
  for (const spec of specs) {
    collectWaitFields(spec.paths, undefined, found);
    for (const [name, schema] of Object.entries(
      spec.components?.schemas ?? {}
    )) {
      collectWaitFields(schema, name, found);
    }
  }
  return found;
};

const isPinned = (field) => {
  return field['x-soat-tool-forced'] !== undefined;
};

describe('wait on the tool surface', () => {
  const fields = waitFields();

  test('the specs declare wait fields', () => {
    assert.ok(fields.length > 0);
  });

  test('every wait is pinned for tool calls or named as the tool caller’s choice', () => {
    const unanswered = fields
      .filter(({ owner, field }) => {
        return !isPinned(field) && !(owner in TOOL_CHOOSES_WAIT);
      })
      .map(({ owner }) => {
        return owner;
      });

    assert.deepEqual(unanswered, []);
  });

  test('a pinned wait is pinned to true', () => {
    const wrong = fields
      .filter(({ field }) => {
        const pin = field['x-soat-tool-forced'];
        return pin !== undefined && pin !== 'true';
      })
      .map(({ owner }) => {
        return owner;
      });

    assert.deepEqual(wrong, []);
  });

  test('every named owner still declares an unpinned wait', () => {
    const unpinnedOwners = new Set(
      fields
        .filter(({ field }) => {
          return !isPinned(field);
        })
        .map(({ owner }) => {
          return owner;
        })
    );
    const stale = Object.keys(TOOL_CHOOSES_WAIT).filter((owner) => {
      return !unpinnedOwners.has(owner);
    });

    assert.deepEqual(stale, []);
  });
});
