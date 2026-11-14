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
 * Every tool an agent's model is offered passes the guardrail gate. A binding
 * declares its gate (`ToolBinding.gate`, required) and never applies it; the
 * one merge that turns bindings into the turn's tool set gates each of them
 * under the project and agent guardrails, so no binding can skip or narrow it.
 */
describe('tool surface gate', () => {
  test('only the merge applies the gate', () => {
    assert.deepEqual(filesMatching(/\bgateResolvedToolsWithGuardrails\s*\(/), [
      'lib/agentToolNames.ts',
    ]);
  });

  test('a binding must declare its gate', () => {
    const names = code(path.join(srcDir, 'lib/agentToolNames.ts'));
    assert.match(names, /\bgate:\s*BindingGate;/);
  });

  test('the merge adds the project and agent guardrails to every binding', () => {
    const names = code(path.join(srcDir, 'lib/agentToolNames.ts'));
    assert.match(
      names,
      /guardrails:\s*\[\s*\.\.\.args\.guardrail\.baseGuardrails,\s*\.\.\.gate\.toolGuardrails,?\s*\]/
    );
  });

  test('the turn is assembled only by the tool surface', () => {
    assert.deepEqual(filesMatching(/\bgateAndMergeBindings\s*\(/), [
      'lib/agentToolSurface.ts',
    ]);
  });
});
