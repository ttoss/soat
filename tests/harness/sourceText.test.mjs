import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('stripComments', () => {
  test('blanks block and line comments, keeping offsets and lines', () => {
    const source = 'a(); /* x\ny */ b(); // z\nc();';
    const stripped = stripComments(source);
    assert.equal(stripped.length, source.length);
    assert.equal(stripped.split('\n').length, 3);
    assert.doesNotMatch(stripped, /[xyz]/);
    assert.match(stripped, /a\(\);[\s\S]*b\(\);[\s\S]*c\(\);/);
  });

  test("a '/*' string literal stays code", () => {
    const source = "const open = '/*';\nhit();\nconst close = '*/';";
    assert.equal(stripComments(source), source);
  });

  test("a '//' inside a string, template or regex stays code", () => {
    const source = [
      "const url = 'http://x';",
      'const t = `a ${b /* c */} //d ${`/*`}`;',
      'const re = /\\/\\*[^*]*\\*\\//g;',
      'const q = x / y / z;',
      'return /\\/\\//.test(v);',
    ].join('\n');
    const stripped = stripComments(source);
    assert.match(stripped, /'http:\/\/x'/);
    assert.match(stripped, /\/\/d \$\{`\/\*`\}`/);
    assert.doesNotMatch(stripped, /\/\* c \*\//);
    assert.match(stripped, /\/\\\/\\\*\[\^\*\]\*\\\*\\\/\/g/);
    assert.match(stripped, /x \/ y \/ z/);
    assert.match(stripped, /return \/\\\/\\\/\/\.test/);
  });
});

/** The ad-hoc comment regexes a site must not write for itself. */
const INLINE_STRIPPERS = [
  String.raw`\/\*[\s\S]*?\*\/`,
  String.raw`\/\*[^]*?\*\/`,
  String.raw`\/\/[^\n]*`,
  String.raw`\/\/.*$`,
  String.raw`^\s*\/\/`,
  String.raw`^\s*(\/\/|\*)`,
];

/** CSS has no `//` comments and no regex; its reader keeps its own. */
const OWN_LEXER = new Set([
  'tests/harness/sourceText.mjs',
  'tests/harness/sourceText.test.mjs',
  'tests/harness/cssRules.mjs',
]);

const SCANNED_DIRS = ['tests/harness', 'packages/server/tests'];

const listFiles = (dir) => {
  return fs
    .readdirSync(path.join(repoRoot, dir), { recursive: true })
    .filter((entry) => {
      return /\.(?:[cm]?js|ts)$/.test(entry) && !entry.includes('node_modules');
    })
    .map((entry) => {
      return path.join(dir, entry);
    });
};

const carriesOwnStripper = (file) => {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
  return INLINE_STRIPPERS.some((pattern) => {
    return source.includes(pattern);
  });
};

describe('comment stripping goes through sourceText.mjs', () => {
  test('no test file carries its own comment regex', () => {
    const offenders = SCANNED_DIRS.flatMap(listFiles)
      .filter((file) => {
        return !OWN_LEXER.has(file);
      })
      .filter(carriesOwnStripper);
    assert.deepEqual(
      offenders,
      [],
      'a regex comment stripper reads a "/*" string as a comment; import stripComments from tests/harness/sourceText.mjs'
    );
  });
});
