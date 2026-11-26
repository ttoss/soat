import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/** The values object of each `Task.update(`: the text up to its `where`. */
const updateValues = (text) => {
  return [...text.matchAll(/\bTask\.update\(/g)].map((match) => {
    const rest = text.slice(match.index);
    const end = rest.indexOf('where:');
    return end === -1 ? rest : rest.slice(0, end);
  });
};

const writesTaskState = (text) => {
  return (
    /\bTask\.(create|bulkCreate|upsert)\(/.test(text) ||
    /\btask\.state\s*=[^=]/.test(text) ||
    updateValues(text).some((values) => {
      return /\bstate\s*[:,}]/.test(values);
    })
  );
};

const read = (file) => {
  return fs.readFileSync(path.join(srcDir, file), 'utf-8');
};

/**
 * A state's `max_tasks` holds only while every entry into a state asks
 * `lib/tasksStateCapacity.ts`; each site that writes a task's state is named
 * here with the call that asks.
 */
const STATE_WRITERS = {
  'lib/tasks.ts': { file: 'lib/tasks.ts', call: 'assertStateHasRoom(' },
  'lib/tasksMigrate.ts': {
    file: 'lib/tasksMigrate.ts',
    call: 'assertStateHasRoom(',
  },
  'lib/tasksTransition.ts': {
    file: 'lib/tasksTransitionCheck.ts',
    call: 'stateCapacityRefusal(',
  },
};

describe('state capacity chokepoint', () => {
  test('every site writing a task state is a known writer', () => {
    const writers = tsFiles(srcDir)
      .filter((file) => {
        return writesTaskState(fs.readFileSync(file, 'utf-8'));
      })
      .map((file) => {
        return path.relative(srcDir, file);
      })
      .sort();
    assert.deepEqual(writers, Object.keys(STATE_WRITERS).sort());
  });

  test('every writer asks the state capacity check', () => {
    for (const [writer, { file, call }] of Object.entries(STATE_WRITERS)) {
      assert.ok(read(file).includes(call), `${writer}: ${file} lacks ${call}`);
    }
    assert.ok(
      read('lib/tasksTransition.ts').includes('assertTransitionAllowed('),
      'lib/tasksTransition.ts: lacks assertTransitionAllowed('
    );
  });
});
