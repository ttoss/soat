import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const code = (relative) => {
  return stripComments(fs.readFileSync(path.join(srcDir, relative), 'utf-8'));
};

/** The argument text of every `<callee>(` call, by balanced parentheses. */
const callArguments = (args) => {
  const found = [];
  let from = 0;
  for (;;) {
    const at = args.source.indexOf(`${args.callee}(`, from);
    if (at === -1) return found;
    let depth = 0;
    let end = at + args.callee.length;
    for (; end < args.source.length; end += 1) {
      if (args.source[end] === '(') depth += 1;
      if (args.source[end] === ')') depth -= 1;
      if (depth === 0) break;
    }
    found.push(args.source.slice(at, end + 1));
    from = end;
  }
};

/**
 * A search query holds its connection until it settles, so each one runs in
 * the bounded transaction `withBoundedSearch` (`lib/vectorSearch.ts`) opens;
 * one without it can run for as long as the database lets it.
 */
describe('search statement timeout', () => {
  const searchQueries = [
    { file: 'lib/knowledgeDocuments.ts', callee: 'db.DocumentChunk.findAll' },
    { file: 'lib/knowledgeMemory.ts', callee: 'db.Memory.findAll' },
  ];

  for (const { file, callee } of searchQueries) {
    test(`every ${callee} in ${file} runs in the bounded transaction`, () => {
      const calls = callArguments({ source: code(file), callee });
      assert.ok(calls.length > 0, `${file} has no ${callee}`);
      for (const call of calls) {
        assert.match(call, /\btransaction\b/, call);
      }
    });
  }

  test('only statementTimeout.ts sets statement_timeout', () => {
    const setters = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return (
          entry.endsWith('.ts') && /statement_timeout\s*=/.test(code(entry))
        );
      });
    assert.deepEqual(setters, ['lib/statementTimeout.ts']);
  });
});
