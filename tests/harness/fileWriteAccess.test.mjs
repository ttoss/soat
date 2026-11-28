import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const CHOKEPOINT = 'rest/v1/fileWriteAccess.ts';

/** The argument text of every `resolveWriteProjectId(...)` call in `source`. */
const writeResolutions = (source) => {
  const calls = [];
  for (const match of source.matchAll(/resolveWriteProjectId\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < source.length) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') depth -= 1;
      end += 1;
    }
    calls.push(source.slice(match.index + match[0].length, end - 1));
  }
  return calls;
};

const isFileWrite = (args) => {
  return /resourceType:\s*'file'/.test(args) || /'files:/.test(args);
};

/**
 * A file write is authorized on the SRN of the path it writes, which only
 * `resolveFileWriteProjectId` computes; a route resolving its project on the
 * file type directly would ask on `file:*` and refuse a path-scoped grant.
 */
describe('file write access', () => {
  test('only the chokepoint resolves a file write project', () => {
    const offenders = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return entry.endsWith('.ts') && entry !== CHOKEPOINT;
      })
      .filter((entry) => {
        const source = stripComments(
          fs.readFileSync(path.join(srcDir, entry), 'utf-8')
        );
        return writeResolutions(source).some(isFileWrite);
      });
    assert.deepEqual(offenders, []);
  });

  test('the chokepoint asks on the written path', () => {
    const source = stripComments(
      fs.readFileSync(path.join(srcDir, CHOKEPOINT), 'utf-8')
    );
    const [call] = writeResolutions(source);
    assert.match(call, /resourceType:\s*'file'/);
    assert.match(call, /resourceId:[^,]*key\.path/);
  });
});
