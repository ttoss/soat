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
    .readFileSync(path.join(srcDir, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const tsFiles = (dir) => {
  return fs
    .readdirSync(path.join(srcDir, dir))
    .filter((entry) => {
      return entry.endsWith('.ts');
    })
    .map((entry) => {
      return `${dir}/${entry}`;
    });
};

/** One route handler, or one formation operation, per block. */
const handlerBlocks = (file) => {
  return code(file).split(
    /\n(?=\w+Router\.(?:get|post|put|patch|delete)\(|\s{2}(?:create|update|remove|fetch|read)\s*:)/
  );
};

/** The body of `export const <name> =`, up to the next top-level export. */
const exportedFunction = (file, name) => {
  const source = code(file);
  const start = source.indexOf(`export const ${name} =`);
  assert.notEqual(start, -1, `${file} exports ${name}`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

const CHECK = /\bassert(?:Project|Memory)SpendWithinQuota\(/;

// Caller-facing calls that embed and check nothing themselves.
const UNCHECKED_ENTRY =
  /\b(?:createDocument|updateDocument|writeMemory|createMemory|updateMemory|searchKnowledge)\(/;

/** The handlers in `file` reaching an unchecked entry with no check before it. */
const uncheckedHandlers = (file) => {
  return handlerBlocks(file)
    .filter((block) => {
      const entry = block.search(UNCHECKED_ENTRY);
      if (entry === -1) return false;
      const check = block.search(CHECK);
      return check === -1 || check > entry;
    })
    .map((block) => {
      return `${file}: ${block.split('\n')[0].trim()}`;
    });
};

/**
 * A `cost_usd` or `tokens` quota refuses embedding spend at the caller-facing
 * entry points, before anything is written; embeddings a run makes
 * (conversation messages, `write_memory`, orchestration nodes) are exempt, the
 * same line the storage cap draws (`modules/quotas.md`).
 */
describe('embedding spend quota', () => {
  // Lib entry points that run the check themselves.
  const CHECKED_INSIDE = {
    'lib/embeddings.ts': ['embedForProject'],
    'lib/documentIngestion.ts': [
      'enqueueDocumentIngestion',
      'reingestDocument',
    ],
  };

  test('only the known modules call the embedding provider', () => {
    const callers = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return entry.endsWith('.ts') && /\bgetEmbeddings?\(/.test(code(entry));
      })
      .sort();
    assert.deepEqual(callers, [
      'lib/chunking.ts',
      'lib/conversationRetrieval.ts',
      'lib/embedding.ts',
      'lib/embeddings.ts',
      'lib/knowledgeEmbedding.ts',
      'lib/memoryContents.ts',
    ]);
  });

  test('every caller-facing handler that embeds checks spend before it', () => {
    const files = [...tsFiles('rest/v1'), ...tsFiles('lib/formation-modules')];
    const unchecked = files.flatMap((file) => {
      return uncheckedHandlers(file);
    });
    assert.deepEqual(unchecked, []);
  });

  test('a version restore checks spend before re-embedding', () => {
    assert.deepEqual(uncheckedHandlers('lib/documentVersions.ts'), []);
  });

  test('the entry points that check inside run the check', () => {
    for (const [file, names] of Object.entries(CHECKED_INSIDE)) {
      for (const name of names) {
        assert.match(exportedFunction(file, name), CHECK, `${file} ${name}`);
      }
    }
  });

  test('a stateless call billed to a project embeds through the check', () => {
    assert.match(
      exportedFunction('lib/embeddings.ts', 'createEmbeddings'),
      /\bembedForProject\(/
    );
  });

  test('the eval embedding scorer embeds through the check', () => {
    assert.match(
      code('lib/evaluationRunExecution.ts'),
      /runEmbeddings:[^;]*\bembedForProject\(/
    );
  });
});
