import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routesDir = fileURLToPath(
  new URL('../../packages/server/src/rest/v1/', import.meta.url)
);

/**
 * `iam:RequestTag/<key>` reads the tags a request writes, so a route that
 * writes caller tags must declare them before it authorizes the write: one that
 * does not answers a Deny on that key with silence, a fail-open. Every caller
 * tag bag passes `assertNoSystemTagKeys`, so a handler calling it is a tag
 * write, and its `declareBodyTags(ctx)` must come before its first `await`,
 * where the permission check runs. The tag sub-resources declare in
 * `tagRoutes.ts` itself, ahead of `resolve`.
 */
const HANDLER_START = /\w+Router\.(post|put|patch)\(/g;

const handlersOf = (source) => {
  const starts = [...source.matchAll(HANDLER_START)].map((match) => {
    return match.index;
  });
  return starts.map((start, i) => {
    return source.slice(start, starts[i + 1] ?? source.length);
  });
};

const files = fs.readdirSync(routesDir).filter((file) => {
  return file.endsWith('.ts') && file !== 'tagRoutes.ts';
});

const tagWriters = files.flatMap((file) => {
  return handlersOf(fs.readFileSync(path.join(routesDir, file), 'utf8'))
    .filter((handler) => {
      return handler.includes('assertNoSystemTagKeys(');
    })
    .map((handler) => {
      const [, method, route] =
        /Router\.(\w+)\(\s*'([^']+)'/.exec(handler) ?? [];
      return { name: `${file}: ${method} ${route}`, handler };
    });
});

describe('every route writing caller tags declares them before authorizing', () => {
  test('the scan finds tag-writing handlers', () => {
    assert.ok(
      tagWriters.length >= 12,
      `expected at least 12 tag-writing handlers, found ${tagWriters.length}`
    );
  });

  for (const { name, handler } of tagWriters) {
    test(name, () => {
      const declared = handler.indexOf('declareBodyTags(ctx)');
      const firstAwait = handler.indexOf('await ');
      assert.ok(declared !== -1, 'never calls declareBodyTags(ctx)');
      assert.ok(
        firstAwait === -1 || declared < firstAwait,
        'declareBodyTags(ctx) runs after the first await'
      );
    });
  }

  test('the tag sub-resources declare ahead of resolve', () => {
    const source = fs.readFileSync(
      path.join(routesDir, 'tagRoutes.ts'),
      'utf8'
    );
    const write = source.slice(source.indexOf('const write = '));
    assert.ok(
      write.indexOf('declareRequestTags(') <
        write.indexOf("args.resolve({ ctx, access: 'write' })")
    );
  });
});
