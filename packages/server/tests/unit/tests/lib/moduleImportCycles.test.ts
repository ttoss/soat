import fs from 'node:fs';
import path from 'node:path';

/**
 * No two modules within a cluster may import each other.
 *
 * This is the deterministic replacement for the prose rule "don't import back".
 * Eleven mutual-import pairs accumulated among the `orchestration*.ts` files
 * before anyone counted them (#910), one of them a real runtime cycle between
 * the engine and the node executors — invisible in review, and only felt at
 * load time. The `agent*.ts` files had grown three more the same way (#911),
 * all of them running through a re-export barrel in `agents.ts` that existed
 * only so seven callers could keep importing `createGeneration` from the CRUD
 * module. So the graph is asserted here instead of remembered.
 *
 * The guard is per-cluster rather than per-package because that is the unit a
 * baseline can honestly shrink to zero: a prefix names a set of files one
 * person owns and can untangle in one pass. It started orchestration-only; the
 * agent cluster was added when #911 broke its cycles, and adding the next
 * cluster is one {@link CLUSTERS} entry.
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
 * A cluster's `knownMutualImports` is a baseline of pairs that predate this
 * guard, not an allowlist to grow. Two assertions keep it honest: a pair not on
 * it fails, and a pair on it that no longer exists fails too — so fixing a
 * cycle forces its entry to be deleted and the baseline can only shrink. The
 * agent cluster's baseline is empty, and must stay that way.
 */
const LIB_DIR = path.resolve(__dirname, '../../../../src/lib');

const CLUSTERS = [
  {
    name: 'orchestration',
    prefix: 'orchestration',
    /**
     * Every remaining pair runs through `orchestrations.ts`, the module that
     * owns the run/node types and their mappers, or through the engine.
     * Untangling that hub is the engine split #912 implies — out of scope for
     * #910, which covered the node-execution layer.
     */
    knownMutualImports: [
      'orchestrationEngine <-> orchestrationWorker',
      'orchestrationEngine <-> orchestrations',
      'orchestrationGraphWire <-> orchestrations',
      'orchestrationRunActions <-> orchestrations',
      'orchestrationValidation <-> orchestrations',
      'orchestrationVersionSnapshot <-> orchestrations',
    ],
    /** A floor on the scan, so a broken regex cannot pass as "no cycles". */
    minModules: 30,
    /** A module known to import several of its siblings, for the same reason. */
    hubModule: 'orchestrationEngine',
  },
  {
    name: 'agent',
    prefix: 'agent',
    knownMutualImports: [],
    minModules: 20,
    hubModule: 'agentGeneration',
  },
];

// Matches `import … from './x'`, `import './x'` and `export … from './x'`.
const RELATIVE_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'\.\/([^']+)'|(?:^|\n)\s*import\s+'\.\/([^']+)'/g;

const buildImportGraph = (prefix: string): Map<string, Set<string>> => {
  const modules = fs
    .readdirSync(LIB_DIR)
    .filter((file) => {
      return file.startsWith(prefix) && file.endsWith('.ts');
    })
    .map((file) => {
      return file.replace(/\.ts$/, '');
    });
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

const mutualImportPairs = (prefix: string): string[] => {
  const graph = buildImportGraph(prefix);
  const pairs: string[] = [];
  for (const [from, targets] of graph) {
    for (const to of targets) {
      if (from < to && graph.get(to)?.has(from))
        pairs.push(`${from} <-> ${to}`);
    }
  }
  return pairs.sort();
};

describe.each(CLUSTERS)(
  '$name module import graph',
  ({ prefix, knownMutualImports, minModules, hubModule }) => {
    test('no module pair imports each other, beyond the known baseline', () => {
      expect(mutualImportPairs(prefix)).toEqual([...knownMutualImports].sort());
    });

    test('the baseline has no stale entries — a fixed cycle must be removed', () => {
      const live = new Set(mutualImportPairs(prefix));
      expect(
        knownMutualImports.filter((pair) => {
          return !live.has(pair);
        })
      ).toEqual([]);
    });

    test('the module scan is non-trivial (guards against a broken regex)', () => {
      const graph = buildImportGraph(prefix);
      expect(graph.size).toBeGreaterThan(minModules);
      expect(graph.get(hubModule)?.size).toBeGreaterThan(5);
    });
  }
);
