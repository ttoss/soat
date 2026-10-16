import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Every action a start on someone's behalf checks, as `startActions.ts` holds it. */
const START_ACTIONS = [
  'agents:CreateAgentGeneration',
  'tools:CallTool',
  'deciders:CreateDecision',
  'tasks:CreateTask',
  'orchestrations:StartRun',
  'evaluations:RunEval',
];

/**
 * Starting work for someone else — a playbook's author, a trigger's creator —
 * is allowed only when that principal could start it directly. The action each
 * kind of work takes is answered once, in `lib/startActions.ts`; a module
 * spelling one of those actions itself to guard a delegated start is a second
 * answer that can drift from the first.
 */
test('only startActions.ts maps a delegated start to its action', () => {
  const modules = [
    'lib/playbookAuthor.ts',
    'lib/triggerValidation.ts',
    'lib/triggerDispatch.ts',
    'rest/v1/triggers.ts',
  ];
  const spelling = modules.filter((module) => {
    const source = fs.readFileSync(path.join(srcDir, module), 'utf-8');
    return START_ACTIONS.some((action) => {
      return source.includes(`'${action}'`);
    });
  });

  assert.deepEqual(spelling, []);
});

test('startActions.ts holds every start action', () => {
  const source = fs.readFileSync(
    path.join(srcDir, 'lib/startActions.ts'),
    'utf-8'
  );
  for (const action of START_ACTIONS) {
    assert.ok(source.includes(`'${action}'`), action);
  }
});
