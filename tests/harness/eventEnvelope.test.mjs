import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a field is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/**
 * A webhook body and an event trigger's input are one envelope, so a
 * subscriber deduping on its `id` reads the same fields either way. It is
 * built once, in `lib/eventEnvelope.ts`; a second transcription is a copy
 * that can drop a field the other carries.
 */
describe('event envelope chokepoint', () => {
  /** Every module that hands a bus event to a consumer outside the bus. */
  const CARRIERS = ['lib/triggerEventDispatch.ts', 'lib/webhookDispatcher.ts'];

  test('only eventEnvelope.ts maps a bus event onto wire keys', () => {
    const hits = tsFiles(srcDir)
      .filter((file) => {
        return /resource_id:\s*[\w.]*\.resourceId\b/.test(code(file));
      })
      .map((file) => {
        return path.relative(srcDir, file);
      });
    assert.deepEqual(hits, ['lib/eventEnvelope.ts']);
  });

  test('every carrier builds its envelope through buildEventEnvelope', () => {
    const missing = CARRIERS.filter((relative) => {
      return !/\bbuildEventEnvelope\(/.test(code(path.join(srcDir, relative)));
    });
    assert.deepEqual(missing, []);
  });
});
