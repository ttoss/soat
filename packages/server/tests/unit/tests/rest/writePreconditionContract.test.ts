import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A `version` counter without a precondition is a lost-update waiting to
 * happen, and the loss is silent: the writer that was overwritten gets a `200`,
 * and the record that would show what it wrote is the one that was replaced.
 *
 * So the counter and the precondition ship together. This test is what makes
 * "together" mechanical rather than remembered — a resource that gains a
 * `version` column and no `writePreconditionOf` call fails here, at the point
 * the column is added, instead of in a corpus six months later.
 *
 * Static because the defect is a missing argument, not a wrong status: a write
 * path that never reads the caller's `expected_version` answers `200` to every
 * request a behavioural test can send, including the stale one.
 */

const V1_DIR = join(__dirname, '../../../../src/rest/v1');
const MODELS_DIR = join(__dirname, '../../../../../postgresdb/src/models');
const HELPERS = join(V1_DIR, 'helpers.ts');

/**
 * Parent resources carrying a config version, mapped to the REST module whose
 * write routes must state a precondition against it.
 *
 * An archive table (`AgentVersion`) carries a `version` too, but it is the
 * archived number rather than a counter anything writes against, and its rows
 * are never updated — so the set below is the parents only, and the first test
 * is what keeps that distinction from silently absorbing a new parent.
 */
const VERSIONED_RESOURCES: Record<string, { module: string; update: string }> =
  {
    'Agent.ts': { module: 'agents.ts', update: 'updateAgent' },
    'Guardrail.ts': { module: 'guardrails.ts', update: 'updateGuardrail' },
    'Orchestration.ts': {
      module: 'orchestrations.ts',
      update: 'updateOrchestration',
    },
    'Workflow.ts': { module: 'workflows.ts', update: 'updateWorkflow' },
    // A document's write routes live on the documents router, but the write
    // that states a precondition is the withdrawal, which is registered from
    // `documentVersionRoutes.ts`.
    'Document.ts': {
      module: 'documentVersionRoutes.ts',
      update: 'withdrawDocument',
    },
  };

/** The one place a route is allowed to read a precondition off a request. */
const PRECONDITION_READER = 'writePreconditionOf';

/** Blanks comments while preserving offsets, so prose is never a match. */
const stripComments = (source: string): string => {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
};

const read = (path: string): string => {
  return stripComments(readFileSync(path, 'utf-8'));
};

/**
 * The argument objects one call passes, as source text.
 *
 * Brace-counted rather than matched with a regex: every update call site here
 * nests at least one object (`...parsed`, a mapped list), and a non-greedy
 * `[^}]*` would stop at the first inner brace and report a missing field that
 * is three lines further down.
 */
const callArguments = (source: string, fn: string): string[] => {
  const calls: string[] = [];
  const opener = new RegExp(`\\b${fn}\\(`, 'g');

  for (const match of source.matchAll(opener)) {
    let depth = 0;
    const start = match.index + match[0].length - 1;

    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (char === '(' || char === '{' || char === '[') depth += 1;
      if (char === ')' || char === '}' || char === ']') depth -= 1;
      if (depth === 0) {
        calls.push(source.slice(start, i + 1));
        break;
      }
    }
  }

  return calls;
};

describe('write precondition contract', () => {
  const modelsDeclaringVersion = readdirSync(MODELS_DIR)
    .filter((entry) => {
      return (
        entry.endsWith('.ts') &&
        !entry.endsWith('Version.ts') &&
        /declare version: number/.test(read(join(MODELS_DIR, entry)))
      );
    })
    .sort();

  test('every resource with a version counter is a declared one', () => {
    expect(modelsDeclaringVersion).toEqual(
      Object.keys(VERSIONED_RESOURCES).sort()
    );
  });

  test('the precondition is read in one place', () => {
    const owners = readdirSync(V1_DIR)
      .filter((entry) => {
        return (
          entry.endsWith('.ts') &&
          new RegExp(`export const ${PRECONDITION_READER}\\b`).test(
            read(join(V1_DIR, entry))
          )
        );
      })
      .sort();

    expect(owners).toEqual(['helpers.ts']);
  });

  test('the reader delegates to the lib parser rather than re-deriving it', () => {
    expect(read(HELPERS)).toMatch(/readWritePrecondition\(/);
  });

  test.each(Object.entries(VERSIONED_RESOURCES))(
    '%s: every write states a precondition',
    (_model, { module, update }) => {
      const source = read(join(V1_DIR, module));
      const withoutPrecondition = callArguments(source, update).filter(
        (args) => {
          return !args.includes('expectedVersion:');
        }
      );

      expect(withoutPrecondition).toEqual([]);
    }
  );

  test.each(Object.entries(VERSIONED_RESOURCES))(
    '%s: the precondition comes from the shared reader',
    (_model, { module }) => {
      expect(read(join(V1_DIR, module))).toContain(
        `expectedVersion: ${PRECONDITION_READER}(ctx)`
      );
    }
  );

  test.each(Object.entries(VERSIONED_RESOURCES))(
    '%s: the request body declares expected_version',
    (_model, { module }) => {
      const spec = readFileSync(
        join(
          V1_DIR,
          '../openapi/v1',
          module.replace('VersionRoutes.ts', 's.ts').replace('.ts', '.yaml')
        ),
        'utf-8'
      );

      expect(spec).toContain(
        "$ref: './concurrency.yaml#/components/schemas/ExpectedVersion'"
      );
      expect(spec).toContain(
        "$ref: './concurrency.yaml#/components/parameters/IfMatchVersion'"
      );
    }
  );

  /**
   * The counter is claimed by a conditional `UPDATE`, never a read-then-write:
   * the second writer has to learn it lost from the statement's own row count.
   * A `where` naming only the row id would make the bump unconditional and
   * silently restore the lost update this whole mechanism exists to refuse.
   */
  test('the version bump is a conditional update inside a transaction', () => {
    const engine = read(
      join(__dirname, '../../../../src/lib/resourceVersionStore.ts')
    );

    expect(engine).toMatch(
      /where: \{ id: a\.resourceDbId, version: a\.expected/
    );
    expect(engine).toMatch(/db\.sequelize\.transaction\(/);
  });
});
