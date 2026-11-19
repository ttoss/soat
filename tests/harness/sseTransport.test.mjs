import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const TRANSPORT = 'lib/sse.ts';

/**
 * What writing a Server-Sent Events answer looks like: the content type set on
 * a response, raw writes to the socket, or a hand-built `data:` frame.
 */
const SSE_WRITES = [
  /['"]Content-Type['"]\s*:\s*['"]text\/event-stream/i,
  /\.type\s*=\s*['"]text\/event-stream/,
  /\bwriteHead\s*\(/,
  /\bres\.write\s*\(/,
  /['"`]data: /,
];

const sourceFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

const writesSse = (file) => {
  const code = stripComments(fs.readFileSync(file, 'utf-8'));
  return SSE_WRITES.some((pattern) => {
    return pattern.test(code);
  });
};

test('the SSE transport itself matches what the check looks for', () => {
  assert.ok(writesSse(path.join(srcDir, TRANSPORT)));
});

test('no module but lib/sse.ts writes a text/event-stream answer', () => {
  const offenders = sourceFiles(srcDir)
    .map((file) => {
      return path.relative(srcDir, file);
    })
    .filter((file) => {
      return file !== TRANSPORT && writesSse(path.join(srcDir, file));
    })
    .sort();

  assert.deepEqual(offenders, []);
});
