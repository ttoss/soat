import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(path.join(srcDir, file), 'utf-8'));
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

/** Where each start type is checked, under the authority the work runs under. */
const ENTRY_GATES = {
  agent: {
    file: 'lib/agentGeneration.ts',
    entry: 'prepareGeneration',
    gate: 'gateGenerationStart',
  },
  tool: {
    file: 'lib/toolsCall.ts',
    entry: 'runResolvedTool',
    gate: 'gateResolvedCall',
  },
  decider: {
    file: 'lib/decisions.ts',
    entry: 'createDecision',
    gate: 'gateStart',
  },
  workflow: {
    file: 'lib/tasks.ts',
    entry: 'startableWorkflow',
    gate: 'gateStart',
    calledFrom: ['lib/tasks.ts'],
  },
  orchestration: {
    file: 'lib/orchestrationStartRun.ts',
    entry: 'findOrchestrationForStartRun',
    gate: 'gateStart',
    calledFrom: ['lib/orchestrationEngine.ts'],
  },
  eval: {
    file: 'lib/evaluationRuns.ts',
    entry: 'planRun',
    gate: 'gateStart',
    calledFrom: ['lib/evaluationRuns.ts'],
  },
};

/**
 * A start is checked at its entry point, under the
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
});

describe('every start type', () => {
  test('every start type is checked by the gate at its entry point', () => {
    const block = code('lib/startActions.ts').match(
      /START_ACTIONS = \{([\s\S]*?)\n\} as const/
    );
    assert.ok(block, 'startActions.ts declares START_ACTIONS');
    const types = [...block[1].matchAll(/^ {2}(\w+): \{/gm)].map((match) => {
      return match[1];
    });
    assert.deepEqual(types.sort(), Object.keys(ENTRY_GATES).sort());
    for (const [type, { file, entry, gate }] of Object.entries(ENTRY_GATES)) {
      assert.match(
        bodyOf(file, entry),
        new RegExp(`\\b${gate}\\(`),
        `${type}: ${entry} crosses ${gate}`
      );
    }
  });

  test('a gated lookup serves only the start it gates', () => {
    for (const { entry, calledFrom } of Object.values(ENTRY_GATES)) {
      if (calledFrom) assert.deepEqual(filesCalling(entry), calledFrom, entry);
    }
  });

  test('gateStart is called only by the entry points it guards', () => {
    assert.deepEqual(
      filesCalling('gateStart'),
      [
        ...new Set(
          Object.values(ENTRY_GATES)
            .filter(({ gate }) => {
              return gate === 'gateStart';
            })
            .map(({ file }) => {
              return file;
            })
        ),
      ].sort()
    );
  });

  test('no caller re-checks a start at run time', () => {
    assert.deepEqual(filesCalling('mayStart'), [
      'lib/playbookStarts.ts',
      'rest/v1/triggers.ts',
    ]);
    for (const file of sourceFiles) {
      assert.doesNotMatch(
        code(file),
        /\b(callerChecksStart|entryChecked|assertExecutorStartable)\b/,
        file
      );
    }
  });
});
