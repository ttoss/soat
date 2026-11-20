import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const SCANNED = [
  'packages/server/src',
  'packages/server/tests',
  'packages/website/docs',
];

const EXTENSIONS = ['.ts', '.mts', '.mjs', '.md', '.mdx', '.yaml', '.yml'];

/** The write-time rejection test is the one place that names it on purpose. */
const ALLOWED = [
  "packages/server/tests/unit/tests/rest/tools.test.ts: test('an unsupported `soat` tool type is rejected at write time', async () => {",
  "packages/server/tests/unit/tests/rest/tools.test.ts: type: 'soat',",
  "packages/server/tests/unit/tests/rest/tools.test.ts: /Unsupported tool type 'soat'/",
];

const toolTypes = () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'packages/server/src/lib/toolWriteValidation.ts'),
    'utf-8'
  );
  const list = source.match(/const TOOL_TYPES = \[([^\]]*)\]/);
  assert.ok(list, 'TOOL_TYPES not found in toolWriteValidation.ts');
  return [...list[1].matchAll(/'([a-z]+)'/g)].map((match) => {
    return match[1];
  });
};

const files = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : files(full);
    }
    return EXTENSIONS.includes(path.extname(entry.name)) ? [full] : [];
  });
};

const patterns = () => {
  const types = toolTypes().join('|');
  return [
    /\btype:\s*['"]soat['"]/,
    /"type":\s*"soat"/,
    /--type[\s=]+['"]?soat\b/,
    /`soat`\s+(tool|call|action|self-call)/,
    /\bsoat (tool|call)s?\b(?!-)/,
    new RegExp(`\`(${types})\`[\\s,/]*(and |or )?\`soat\``),
    new RegExp(`\`soat\`[\\s,/]*(and |or )?\`(${types})\``),
  ];
};

const soatToolTypeHits = (args) => {
  const relative = path.relative(repoRoot, args.file);
  const matches = (line) => {
    return args.patterns.some((pattern) => {
      return pattern.test(line);
    });
  };
  return fs
    .readFileSync(args.file, 'utf-8')
    .split('\n')
    .filter(matches)
    .map((line) => {
      return `${relative}: ${line.trim()}`;
    })
    .filter((hit) => {
      return !ALLOWED.includes(hit);
    });
};

/**
 * `soat` is not a tool type (`TOOL_TYPES`); platform actions are `builtin`
 * tools. Prose or examples naming a `soat` tool, call or `type` teach a value
 * the server rejects.
 */
describe('tool type vocabulary', () => {
  test('soat is not in TOOL_TYPES', () => {
    assert.ok(!toolTypes().includes('soat'));
  });

  test('no file names a `soat` tool type', () => {
    const scanned = patterns();
    const hits = SCANNED.flatMap((dir) => {
      return files(path.join(repoRoot, dir));
    }).flatMap((file) => {
      return soatToolTypeHits({ file, patterns: scanned });
    });
    assert.deepEqual(hits, []);
  });
});
