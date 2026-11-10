import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
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

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

const filesMatching = (pattern) => {
  return sourceFiles
    .filter((entry) => {
      return pattern.test(code(path.join(srcDir, entry)));
    })
    .sort();
};

/**
 * Every bus subscriber that declares which events it wants filters through
 * `subscriberReceivesEvent` (`lib/eventMatching.ts`): the type, resource and
 * data match, then the read guard against its `policy_ids`.
 */
describe('event filter chokepoint', () => {
  test('the matcher and the read guard are called only by the shared filter', () => {
    assert.deepEqual(
      filesMatching(
        /\b(matchesEvent|matchesEventFilter|mayReadEventResource)\(|EVENT_READ_ACTIONS\[/
      ),
      ['lib/eventMatching.ts']
    );
  });

  test('every subscriber storing an event filter receives through it', () => {
    const readsFilter = filesMatching(/\.eventResources\b/);
    const subscribers = filesMatching(/\bonEvent\(/).filter((file) => {
      return readsFilter.includes(file);
    });
    assert.deepEqual(subscribers, [
      'lib/triggerEventDispatch.ts',
      'lib/webhookDispatcher.ts',
    ]);
    for (const file of subscribers) {
      assert.match(
        code(path.join(srcDir, file)),
        /\bsubscriberReceivesEvent\(/,
        file
      );
    }
  });
});

/**
 * A model whose `policyIds` is `JSONB` names the public ids of the policies it
 * acts under: an agent, or a direct carrier in `lib/policyCarriers.ts`, so a
 * policy it names cannot be deleted and an edit to it is checked.
 */
describe('policy carrier registry', () => {
  test('every model carrying policy public ids is registered', () => {
    const carriers = fs
      .readdirSync(modelsDir)
      .filter((file) => {
        return /DataType\.JSONB[^)]*\)\s*\n\s*declare policyIds/.test(
          fs.readFileSync(path.join(modelsDir, file), 'utf-8')
        );
      })
      .map((file) => {
        return file.replace(/\.ts$/, '');
      })
      .sort();
    const registry = code(path.join(srcDir, 'lib/policyCarriers.ts'));
    const registered = [...registry.matchAll(/return db\.(\w+);/g)].map(
      (match) => {
        return match[1];
      }
    );
    assert.deepEqual(carriers, ['Agent', ...registered].sort());
  });
});
