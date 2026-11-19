import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  })
  .sort();

/** The text of the first argument of each call opened at `pattern`. */
const firstArguments = (source, pattern) => {
  const found = [];
  for (const match of source.matchAll(pattern)) {
    let depth = 0;
    let index = match.index + match[0].length;
    const start = index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if ('({['.includes(char)) depth += 1;
      if (')}]'.includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      }
      if (char === ',' && depth === 0) break;
    }
    found.push(source.slice(start, index).trim());
  }
  return found;
};

const generationWrites = () => {
  return sourceFiles.flatMap((entry) => {
    const source = stripComments(
      fs.readFileSync(path.join(srcDir, entry), 'utf-8')
    );
    return firstArguments(
      source,
      /\bGeneration\.(update|create|upsert|bulkCreate)\(/g
    ).map((values) => {
      return { file: entry, values };
    });
  });
};

const filesWhere = (predicate) => {
  return [
    ...new Set(
      generationWrites()
        .filter(predicate)
        .map((write) => {
          return write.file;
        })
    ),
  ].sort();
};

/** Whether `entry` catches a `settleGeneration` call with its own handler. */
const catchesSettleOtherwise = (entry) => {
  const source = stripComments(
    fs.readFileSync(path.join(srcDir, entry), 'utf-8')
  );
  return firstArguments(source, /\bsettleGeneration\(/g).some((call) => {
    const rest = source
      .slice(source.indexOf(call) + call.length + 1)
      .trimStart();
    return (
      rest.startsWith('.catch(') &&
      !/^\.catch\(\s*logSettleFailure\(/.test(rest)
    );
  });
};

/**
 * A generation's status has one writer per transition: the two claims take it
 * to `running` with a fresh lease, and `settleGeneration` takes it anywhere
 * else, fenced by that lease, so a stale writer cannot overwrite a settle.
 */
describe('generation status writes', () => {
  test('a literal status is written only by the claims', () => {
    assert.deepEqual(
      filesWhere((write) => {
        return /^\{/.test(write.values) && /\bstatus\s*:/.test(write.values);
      }),
      ['lib/generationPendingState.ts', 'lib/generations.ts']
    );
  });

  test('a computed write of the row is made only by settleGeneration', () => {
    assert.deepEqual(
      filesWhere((write) => {
        return !/^\{/.test(write.values) && !/\(/.test(write.values);
      }),
      ['lib/generationSettle.ts']
    );
  });

  test('a settle that must not throw is caught only by logSettleFailure', () => {
    assert.deepEqual(sourceFiles.filter(catchesSettleOtherwise), []);
  });

  test('a generation instance never writes its own status', () => {
    const offenders = sourceFiles.filter((entry) => {
      const source = stripComments(
        fs.readFileSync(path.join(srcDir, entry), 'utf-8')
      );
      return /\b(gen|generation)\.(update|set)\(\s*\{[^}]*\bstatus\s*:/.test(
        source
      );
    });
    assert.deepEqual(offenders, []);
  });
});
