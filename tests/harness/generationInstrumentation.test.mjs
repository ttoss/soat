import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const sources = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  })
  .sort()
  .map((entry) => {
    return {
      file: entry,
      source: stripComments(fs.readFileSync(path.join(srcDir, entry), 'utf-8')),
    };
  });

const filesMatching = (pattern) => {
  return sources
    .filter(({ source }) => {
      return pattern.test(source);
    })
    .map(({ file }) => {
      return file;
    });
};

/**
 * A generation's steps and tool calls are recorded by one instrumentation
 * point: the SDK callbacks `segmentCallOptions` wires. A second site would
 * record a call twice, or record one surface's calls and not another's.
 */
describe('generation instrumentation', () => {
  test('the step and tool-execution callbacks are wired only by segmentCallOptions', () => {
    assert.deepEqual(
      filesMatching(/\bon(StepStart|ToolExecutionStart|ToolExecutionEnd)\b/),
      ['lib/generationInstrumentation.ts', 'lib/generationSegment.ts']
    );
  });

  test('a tool call is recorded only through the instrumentation', () => {
    assert.deepEqual(filesMatching(/\brecordProgress\(/), [
      'lib/generationInstrumentation.ts',
    ]);
    assert.deepEqual(filesMatching(/\brecordToolExecuted\(/), [
      'lib/generationInstrumentation.ts',
    ]);
  });

  test('progress rows are written only by generationProgress.ts', () => {
    assert.deepEqual(filesMatching(/\bGenerationProgressEvent\b/), [
      'lib/generationProgress.ts',
    ]);
  });

  test('no tool execute is wrapped to record activity', () => {
    // The orchestration tool node runs in no generation, so it records its
    // own entry; every generation's call records through the instrumentation.
    assert.deepEqual(filesMatching(/kind:\s*'action_executed'/), [
      'lib/agentToolActivity.ts',
      'lib/orchestrationNodeExecutors.ts',
    ]);
  });
});
