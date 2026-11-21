import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const routesDir = path.join(srcDir, 'rest/v1');

const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

/** Route modules; `helpers.ts` is where the parsers live. */
const routeFiles = fs
  .readdirSync(routesDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts') && entry !== 'helpers.ts';
  })
  .sort();

const PARSED_READ =
  /parse(?:Nullable)?ToolContextBody\(\{\s*raw:\s*[A-Za-z_]\w*\.tool_context,\s*reservedPrefix:\s*'(refuse|pass)',?\s*\}\)/g;

const TYPE_MEMBER = /^\s*tool_context\?: unknown;$/;

/**
 * A route reads `tool_context` off a request body only through
 * `parseToolContextBody` / `parseNullableToolContextBody`, which refuse a
 * malformed bag and, unless the route passes them to a rule of its own, a key
 * under the deployment's reserved prefix.
 */
describe('a request body tool_context', () => {
  test('every route mention is an unknown-typed member or a parsed read', () => {
    const offenders = routeFiles.flatMap((file) => {
      const lines = code(path.join(routesDir, file))
        .replace(PARSED_READ, '')
        .split('\n');
      return lines
        .map((line, index) => {
          return { line, index };
        })
        .filter(({ line }) => {
          return line.includes('tool_context') && !TYPE_MEMBER.test(line);
        })
        .map(({ index }) => {
          return `${file}:${index + 1}`;
        });
    });

    assert.deepEqual(offenders, []);
  });

  /**
   * `iam.ts`: a token's layer, where `iam:PinReservedToolContext` decides.
   * `tools.ts`: a direct call's root bag, where the token's layer is stamped
   * over a reserved key (`stampToolContextLayer`).
   */
  test('only the token route and the tool call route pass a reserved key on', () => {
    const passing = routeFiles.flatMap((file) => {
      return [...code(path.join(routesDir, file)).matchAll(PARSED_READ)]
        .filter((match) => {
          return match[1] === 'pass';
        })
        .map(() => {
          return file;
        });
    });

    assert.deepEqual(passing, ['iam.ts', 'tools.ts']);
  });

  test('a formation template is walked for reserved keys before its module hooks', () => {
    assert.match(
      code(path.join(srcDir, 'lib/formationsValidation.ts')),
      /assertNoReservedToolContextKeysIn\(/
    );
  });
});
