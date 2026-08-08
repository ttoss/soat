import fs from 'node:fs';
import path from 'node:path';

/**
 * No two orchestration modules may import each other.
 *
 * This is the deterministic replacement for the prose rule "don't import back".
 * Eleven mutual-import pairs accumulated among the `orchestration*.ts` files
 * before anyone counted them (#910), one of them a real runtime cycle between
 * the engine and the node executors — invisible in review, and only felt at
 * load time. So the graph is asserted here instead of remembered.
 *
 * Every static edge counts, `import type` included: a type that can only live
 * next to an implementation is exactly how five of the six #910 cycles formed,
 * and the fix (a leaf types module) is the same either way.
 *
 * A **dynamic** `import('./x')` is deliberately not an edge. It resolves when
 * the call is made rather than when the module graph is built, so it cannot
 * close a load-time cycle — it is one of the two ways to break one (the other
 * being a registry, as `registerApprovalResumeHandler` does).
 * `orchestrationNestedRun.ts` reaches the engine that way on purpose.
 *
 * {@link KNOWN_MUTUAL_IMPORTS} is a baseline of pairs that predate this guard,
 * not an allowlist to grow. Two assertions keep it honest: a pair not on it
 * fails, and a pair on it that no longer exists fails too — so fixing a cycle
 * forces its entry to be deleted and the baseline can only shrink.
 */
const LIB_DIR = path.resolve(__dirname, '../../../../src/lib');

/**
 * Every remaining pair runs through `orchestrations.ts`, the module that owns
 * the run/node types and their mappers, or through the engine. Untangling that
 * hub is the accessor-factory work (#912) and the engine split it implies —
 * out of scope for #910, which covered the node-execution layer.
 */
const KNOWN_MUTUAL_IMPORTS = [
  'orchestrationEngine <-> orchestrationWorker',
  'orchestrationEngine <-> orchestrations',
  'orchestrationGraphWire <-> orchestrations',
  'orchestrationRunActions <-> orchestrations',
  'orchestrationValidation <-> orchestrations',
  'orchestrationVersionSnapshot <-> orchestrations',
];

const orchestrationModules = (): string[] => {
  return fs
    .readdirSync(LIB_DIR)
    .filter((f) => {
      return f.startsWith('orchestration') && f.endsWith('.ts');
    })
    .map((f) => {
      return f.replace(/\.ts$/, '');
    });
};

// Matches `import … from './x'`, `import './x'` and `export … from './x'`.
const RELATIVE_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'\.\/([^']+)'|(?:^|\n)\s*import\s+'\.\/([^']+)'/g;

const buildImportGraph = (): Map<string, Set<string>> => {
  const modules = orchestrationModules();
  const known = new Set(modules);
  return new Map(
    modules.map((moduleName) => {
      const source = fs.readFileSync(
        path.join(LIB_DIR, `${moduleName}.ts`),
        'utf8'
      );
      const targets = new Set<string>();
      for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
        const target = match[1] ?? match[2];
        if (target && known.has(target)) targets.add(target);
      }
      return [moduleName, targets];
    })
  );
};

const mutualImportPairs = (): string[] => {
  const graph = buildImportGraph();
  const pairs: string[] = [];
  for (const [from, targets] of graph) {
    for (const to of targets) {
      if (from < to && graph.get(to)?.has(from))
        pairs.push(`${from} <-> ${to}`);
    }
  }
  return pairs.sort();
};

describe('orchestration module import graph', () => {
  test('no module pair imports each other, beyond the known baseline', () => {
    expect(mutualImportPairs()).toEqual([...KNOWN_MUTUAL_IMPORTS].sort());
  });

  test('the baseline has no stale entries — a fixed cycle must be removed', () => {
    const live = new Set(mutualImportPairs());
    expect(
      KNOWN_MUTUAL_IMPORTS.filter((pair) => {
        return !live.has(pair);
      })
    ).toEqual([]);
  });

  test('the module scan is non-trivial (guards against a broken regex)', () => {
    const graph = buildImportGraph();
    expect(graph.size).toBeGreaterThan(30);
    expect(graph.get('orchestrationEngine')?.size).toBeGreaterThan(5);
  });
});
