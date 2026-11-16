import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(
  new URL('../../packages/server/src/lib/documentIngestion.ts', import.meta.url)
);

const CHOKEPOINT = 'startDocumentIngestion';

const body = (source, name) => {
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} is not defined`);
  return source.slice(start, source.indexOf('\n};', start));
};

const count = (text, needle) => {
  return text.split(needle).length - 1;
};

/**
 * A background ingest moves its document to `processing` as soon as it
 * starts, so a `202` read after scheduling races it: the answer reads the
 * document first, in one function every ingest route goes through.
 */
describe('async ingestion answers before it starts', () => {
  const source = fs.readFileSync(LIB, 'utf-8');

  test(`only ${CHOKEPOINT} starts the pipeline`, () => {
    const chokepoint = body(source, CHOKEPOINT);
    assert.equal(
      count(source, 'processDocumentIngestion('),
      count(chokepoint, 'processDocumentIngestion(')
    );
    assert.equal(count(source, 'setImmediate('), 1);
    assert.equal(count(chokepoint, 'setImmediate('), 1);
  });

  test(`${CHOKEPOINT} reads the answer before scheduling the run`, () => {
    const chokepoint = body(source, CHOKEPOINT);
    const scheduled = chokepoint.indexOf('setImmediate(');
    const read = chokepoint.lastIndexOf('toIngestedRecord(', scheduled);
    assert.ok(read !== -1 && read < scheduled);
  });
});
