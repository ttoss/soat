import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');
const libDir = path.join(repoRoot, 'packages/server/src/lib');

/**
 * A `tool_context` bag is a credential wherever it is stored, so every model
 * that holds one owes the same three answers: the keys are validated and the
 * reserved identity keys stripped before the row is written, the bag is never
 * returned on a read, and whether a `{{secret:...}}` inside it is resolved at
 * use is stated rather than inherited.
 *
 * `toolContextCarrier.ts` is where the first and third are answered once. These
 * hold the set of carriers to the ones that go through it: a sixth model
 * growing the column is the case that would otherwise re-derive the answers by
 * hand, which is how the five here came to disagree.
 */
describe('tool_context carriers', () => {
  /** Model file → the module that writes its bag. */
  const CARRIERS = {
    'EvalRun.ts': 'evaluationRuns.ts',
    'OrchestrationRun.ts': 'orchestrationEngine.ts',
    'Session.ts': 'sessions.ts',
    'Task.ts': 'tasks.ts',
    'Trigger.ts': 'triggers.ts',
  };

  const modelsWithBag = fs
    .readdirSync(modelsDir)
    .filter((entry) => {
      return (
        entry.endsWith('.ts') &&
        /declare toolContext:/.test(
          fs.readFileSync(path.join(modelsDir, entry), 'utf-8')
        )
      );
    })
    .sort();

  test('every model carrying a bag is a declared carrier', () => {
    assert.deepEqual(modelsWithBag, Object.keys(CARRIERS).sort());
  });

  test('every carrier takes its bag through the one ingress', () => {
    const missing = Object.values(CARRIERS).filter((module) => {
      return !/acceptStoredToolContext/.test(
        fs.readFileSync(path.join(libDir, module), 'utf-8')
      );
    });

    assert.deepEqual(missing, []);
  });

  /**
   * The one module that builds `tool_context` into an outbound body: the
   * arguments of a nested `soat` tool call, which is a write the caller's bag
   * is forwarded on, not a read of a stored one.
   */
  const FORWARDS_THE_BAG = ['agentToolResolverSoatBody.ts'];

  /** Source with comments dropped, so prose naming the field is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*(\/\/|\*)/.test(line);
      })
      .join('\n');
  };

  /**
   * The read side, held from the other direction: a bag reaches a response only
   * through a mapper, and a mapper is the one place in `lib` that spells the
   * field in its wire casing. So the field's wire spelling appearing as a key
   * anywhere else in `lib` is a second read path being built.
   */
  test('no module emits the bag on a read', () => {
    const emitting = fs
      .readdirSync(libDir, { recursive: true })
      .filter((entry) => {
        return (
          typeof entry === 'string' &&
          entry.endsWith('.ts') &&
          !FORWARDS_THE_BAG.includes(path.basename(entry))
        );
      })
      .filter((entry) => {
        return /tool_context\s*:/.test(code(path.join(libDir, entry)));
      })
      .sort();

    assert.deepEqual(emitting, []);
  });
});
