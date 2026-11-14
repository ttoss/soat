import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverDir = path.join(repoRoot, 'packages/server');

/** Every model whose rows are durable work: each stores its authority. */
const DURABLE_MODELS = [
  'Generation',
  'OrchestrationRun',
  'Task',
  'PlaybookExecution',
  'EvalRun',
  'TriggerFiring',
];

/** Credentials and readers durable work no longer has: a token per drive. */
const REMOVED_SYMBOLS = [
  'onBehalfOfIdentity',
  'resolveGenerationIdentitySets',
  'triggerToken',
  'signTriggerToken',
  'signRunToken',
  'buildRunAuthHeader',
  'SOAT_TRIGGER_TOKEN_TTL',
  'SOAT_RUN_TOKEN_TTL',
  'resolveStartingPrincipal',
  'readRunTokenPrincipal',
  'readStoredStartingPrincipal',
  'readStoredRunPrincipal',
  'StartingPrincipal',
  'createdByUserId',
  'tokenUser',
  'TRIGGER_CREATOR_UNAVAILABLE',
  'replayedAuthHeader',
  'isTriggerToken',
  'isRunToken',
  'toolsAuthHeader',
];

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*(\/\/|\*)/.test(line);
    })
    .join('\n');
};

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'coverage'].includes(entry.name)
        ? []
        : tsFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
};

/** The object literal a `create(` call opens, up to its matching brace. */
const createdLiteral = (source, from) => {
  const open = source.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
};

describe('durable work stores its authority', () => {
  test('every create of a durable row writes `authority` through storedAuthority', () => {
    const pattern = new RegExp(
      `db\\.(${DURABLE_MODELS.join('|')})\\.(create|bulkCreate|findOrCreate|upsert)\\(`,
      'g'
    );
    const offenders = [];
    let sites = 0;
    for (const file of tsFiles(path.join(serverDir, 'src'))) {
      const source = code(file);
      for (const match of source.matchAll(pattern)) {
        sites += 1;
        const literal = createdLiteral(source, match.index);
        if (!/\bauthority\b/.test(literal)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
        }
      }
    }
    assert.ok(sites >= DURABLE_MODELS.length, 'no durable create was found');
    assert.deepEqual(offenders, []);
  });

  test('only storedAuthority serializes an authority into a column', () => {
    const offenders = tsFiles(path.join(serverDir, 'src'))
      .filter((file) => {
        return !file.endsWith(path.join('lib', 'workAuthority.ts'));
      })
      .filter((file) => {
        return /\bserializeWorkAuthority\b/.test(code(file));
      })
      .map((file) => {
        return path.relative(repoRoot, file);
      });
    assert.deepEqual(offenders, []);
  });

  test('only the auth middleware reads Authorization: work carries its authority as a value', () => {
    const reads =
      /headers\??\.(authorization\b|\[\s*['"]authorization['"])|headers\[\s*['"]authorization['"]|\.get\(\s*['"]authorization['"]/i;
    const readers = tsFiles(path.join(serverDir, 'src'))
      .filter((file) => {
        return reads.test(code(file));
      })
      .map((file) => {
        return path.relative(path.join(serverDir, 'src'), file);
      })
      .sort();
    assert.deepEqual(readers, ['middleware/auth.ts']);
  });

  test('no removed credential or reader is named again', () => {
    const offenders = [
      ...tsFiles(path.join(serverDir, 'src')),
      ...tsFiles(path.join(serverDir, 'tests')),
    ].flatMap((file) => {
      const source = code(file);
      return REMOVED_SYMBOLS.filter((symbol) => {
        return new RegExp(`\\b${symbol}\\b`).test(source);
      }).map((symbol) => {
        return `${path.relative(repoRoot, file)}: ${symbol}`;
      });
    });
    assert.deepEqual(offenders, []);
  });
});
