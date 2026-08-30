import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A generation that continues an existing chain must declare its parent.
 *
 * `createGeneration` derives the whole chain from `initiator_generation_id` —
 * the trace lineage the hop inherits and the budget that stops a chain from
 * extending itself forever. Declaring the parent is therefore the only thing a
 * continuation has to get right, and the only thing that cannot be checked at
 * runtime: a spawn that omits it is not an error, it is a brand-new root, which
 * is exactly what an unbounded chain looks like from the inside.
 *
 * Three of the four paths that spawn one had omitted it (#1161). The one that
 * got it right did so by convention, and the convention is what lost: a
 * continuation reads like an ordinary `createGeneration` call, so the wrong
 * version is both shorter and the one there were more examples of. Hence a
 * static check rather than a rule in a document.
 *
 * A genuine root — a trigger firing, an eval run, an orchestration node — has
 * no parent to declare and is listed below with the reason it starts a chain
 * instead of continuing one.
 */

const SRC_DIR = join(__dirname, '../../../../src');
const LIB_DIR = join(SRC_DIR, 'lib');

/**
 * Call sites that start a chain rather than continue one. Adding an entry is a
 * claim that nothing resumes this path — that its caller is an external event,
 * not an earlier generation.
 */
const ROOT_SPAWNERS: Record<string, string> = {
  'lib/triggerDispatch.ts': 'a trigger firing is an external event',
  'lib/tasksDispatch.ts':
    'a task transition is driven by its own state machine',
  'lib/orchestrationNodeExecutors.ts':
    'a node is bounded by its run graph, and carries the run instead',
  'lib/evaluationRunExecution.ts': 'an eval item is one row of a dataset',
  'lib/converterInvocation.ts': 'an ingestion rule converts one document',
};

/**
 * Where the record write itself lives, plus the one path that seeds a suspended
 * generation directly instead of going through `createGeneration`.
 */
const RECORD_WRITERS = new Set([
  'lib/generations.ts',
  'lib/agentGeneration.ts',
]);

const collectSourceFiles = (dir: string): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }

    if (full.endsWith('.ts')) files.push(full);
  }

  return files;
};

/**
 * The argument text of every call to `name` in `source`, read by matching the
 * call's own parentheses so a nested object or call cannot truncate it.
 */
const callArguments = (args: { source: string; name: string }): string[] => {
  const calls: string[] = [];
  const opener = new RegExp(`\\b${args.name}\\(`, 'g');

  let match: RegExpExecArray | null;

  while ((match = opener.exec(args.source)) !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;

    for (; index < args.source.length; index += 1) {
      const char = args.source[index];
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    calls.push(args.source.slice(match.index, index + 1));
  }

  return calls;
};

const libFiles = collectSourceFiles(LIB_DIR);

const relativeToSrc = (file: string): string => {
  return relative(SRC_DIR, file).split('\\').join('/');
};

describe('generation spawn contract', () => {
  test('a lib generation spawn declares its initiator or is a listed root', () => {
    const violations: string[] = [];

    for (const file of libFiles) {
      const key = relativeToSrc(file);
      // The definition itself, and the function that resolves the chain from
      // the declaration, are not spawn sites.
      if (key === 'lib/agentGeneration.ts') continue;

      const source = readFileSync(file, 'utf8');
      const calls = callArguments({ source, name: 'createGeneration' });
      if (calls.length === 0) continue;

      const undeclared = calls.filter((call) => {
        return !call.includes('initiatorGenerationId');
      });
      if (undeclared.length === 0) continue;

      if (ROOT_SPAWNERS[key]) continue;

      violations.push(
        `${key}: ${undeclared.length} createGeneration call(s) declare no initiatorGenerationId`
      );
    }

    expect(violations).toEqual([]);
  });

  test('every listed root spawner still spawns', () => {
    // A stale entry is worse than a missing one: it silently exempts a file
    // that may since have grown a continuation.
    for (const key of Object.keys(ROOT_SPAWNERS)) {
      const file = join(SRC_DIR, key);
      const calls = callArguments({
        source: readFileSync(file, 'utf8'),
        name: 'createGeneration',
      });
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  test('a generation record written outside the choke point resolves its lineage', () => {
    // Coarser than the check above by design: the lineage may be spread from a
    // resolved object rather than named field by field, so what is checked is
    // that the file resolves it at all. The runtime half is covered by
    // `generationChain.test.ts` and the chain assertions in
    // `guardrailForcedToolLoop.test.ts`.
    const violations: string[] = [];

    for (const file of libFiles) {
      const key = relativeToSrc(file);
      if (RECORD_WRITERS.has(key)) continue;

      const source = readFileSync(file, 'utf8');
      const calls = callArguments({ source, name: 'createGenerationRecord' });
      if (calls.length === 0) continue;

      if (source.includes('resolveChainLineage')) continue;

      violations.push(
        `${key}: writes a generation record without resolving its chain lineage`
      );
    }

    expect(violations).toEqual([]);
  });
});
