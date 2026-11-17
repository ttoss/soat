import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(path.join(srcDir, file), 'utf-8')
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

const filesCalling = (name) => {
  const pattern = new RegExp(`\\b${name}\\(`);
  return sourceFiles
    .filter((entry) => {
      return pattern.test(code(entry));
    })
    .sort();
};

/** The body of `const <name> = async (...) => { ... }` up to the next top-level const. */
const bodyOf = (file, name) => {
  const source = code(file);
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${file} declares ${name}`);
  const next = source.indexOf('\nconst ', start + 1);
  const nextExport = source.indexOf('\nexport const ', start + 1);
  const ends = [next, nextExport].filter((index) => {
    return index !== -1;
  });
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
};

/**
 * A tool or generation start is checked at its entry point, under the
 * authority the work runs under, so no caller can start one around the check.
 */
describe('start chokepoint', () => {
  test('every generation crosses gateGenerationStart before it is prepared', () => {
    assert.deepEqual(filesCalling('gateGenerationStart'), [
      'lib/agentGeneration.ts',
    ]);
    assert.match(
      bodyOf('lib/agentGeneration.ts', 'prepareGeneration'),
      /\bgateGenerationStart\(/
    );
    assert.deepEqual(filesCalling('prepareGeneration'), [
      'lib/agentGeneration.ts',
    ]);
  });

  test('a generation is dispatched only from the module that gates it', () => {
    assert.deepEqual(filesCalling('dispatchGeneration'), [
      'lib/agentGeneration.ts',
    ]);
    assert.deepEqual(filesCalling('resolveContextAndRecord'), [
      'lib/agentGeneration.ts',
    ]);
  });

  test('a turn context is built only by a start or a resume of a started turn', () => {
    assert.deepEqual(filesCalling('buildGenerationContext'), [
      'lib/agentClientToolReHandoff.ts',
      'lib/agentGeneration.ts',
    ]);
  });

  test('a tool is dispatched only after gateToolCall, for every type', () => {
    assert.deepEqual(filesCalling('dispatchDirectTool'), ['lib/toolsCall.ts']);
    assert.deepEqual(filesCalling('runPipeline'), ['lib/toolsCall.ts']);
    const run = bodyOf('lib/toolsCall.ts', 'runResolvedTool');
    assert.ok(
      run.indexOf('gateResolvedCall(') < run.indexOf('dispatchDirectTool('),
      'runResolvedTool gates before it dispatches'
    );
    assert.doesNotMatch(
      bodyOf('lib/toolCallGate.ts', 'gateToolCall'),
      /\.type\b/,
      'gateToolCall exempts no tool type'
    );
  });

  test('agent and tool starts are checked at their entry point', () => {
    const actions = code('lib/startActions.ts');
    for (const type of ['agent', 'tool']) {
      assert.match(
        actions,
        new RegExp(`\\b${type}: \\{[^}]*entryChecked: true`),
        `${type} is entryChecked`
      );
    }
  });

  test('a run-time caller checks only the starts no entry point checks', () => {
    for (const file of filesCalling('mayStart').filter((entry) => {
      return !entry.startsWith('rest/') && entry !== 'lib/playbookStarts.ts';
    })) {
      assert.match(code(file), /\bcallerChecksStart\(/, file);
    }
    for (const file of filesCalling('assertExecutorStartable')) {
      assert.match(code(file), /\bcallerChecksStart\(/, file);
    }
  });
});
