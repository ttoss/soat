import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/**
 * A tool or agent named by id in a stored field, or in a request that runs it,
 * resolves in `lib/resourceReferences.ts`: in the project of the row that holds
 * the reference, and nowhere else. A module querying `Tool` or `Agent` itself
 * is either that module or one listed below with the reason its lookup is not
 * a reference, so a new lookup states which it is instead of re-deriving the
 * scope rule by hand.
 */
describe('tool and agent references', () => {
  const CHOKEPOINT = 'lib/resourceReferences.ts';

  /** Module → why its `Tool`/`Agent` query is not a by-id reference. */
  const NOT_A_REFERENCE = {
    'lib/actorFilters.ts': 'narrows a listing already scoped to the caller',
    'lib/agentNonStreamGeneration.ts':
      "reads tools by name inside the running agent's project",
    'lib/agents.ts': "lists the caller's agents",
    'lib/agentVersions.ts': "the agent's own version routes",
    'lib/aiProviders.ts': "lists a provider's dependents",
    'lib/completionModel.ts':
      'reads back the internal id of an agent already resolved',
    'lib/guardrailDryRun.ts': 'reads a display name for a report',
    'lib/guardrailRuntimeMetrics.ts': 'reads display names for a report',
    'lib/guardrails.ts': "lists a project's tools and agents",
    'lib/ingestionRuleRefs.ts':
      'reads the type of a converter already resolved to an internal id',
    'lib/knowledgeConfigBackfill.ts': 'a schema backfill over every row',
    'lib/modelRouteDefaults.ts': "lists a route's dependents",
    'lib/modelRoutes.ts': "lists a route's dependents",
    'lib/projectDependents.ts': "counts a project's dependents",
    'lib/projectPause.ts':
      'reads the project of an agent already resolved, for the pause check',
    'lib/quotaEnforcement.ts':
      'reads the running agent to find the quotas that apply',
    'lib/scopedIdFilters.ts': 'narrows a listing already scoped to the caller',
    'lib/sessions.ts':
      'narrows a listing already scoped to the caller, and reads by internal id',
    'lib/shareableTypes.ts': 'the publisher reading its own resource',
    'lib/shareReferences.ts':
      "finds a grantee's resources naming a shared resource",
    'lib/tools.ts': "lists the caller's tools",
    'lib/traceContentPolicy.ts': "reads the running agent's own policy",
    'lib/usageGenerationAttribution.ts':
      "reads a generation's own agent to name its publisher",
    'lib/usageToolRecording.ts': 'maps a metered call to its internal ids',
  };

  // A direct query, or the model handed to a generic lookup — never an
  // `include` entry, which names its association with `as`.
  const LOOKUP =
    /\bdb\.(Tool|Agent)\.(findOne|findAll|findByPk|findAndCountAll)\b|\bmodel:\s*db\.(Tool|Agent)\s*,(?!\s*as:)/;

  /** Source with comments dropped, so prose naming a model is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*\/\//.test(line);
      })
      .join('\n');
  };

  const walk = (dir) => {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  };

  const modulesWithLookups = walk(srcDir)
    .filter((file) => {
      return LOOKUP.test(code(file));
    })
    .map((file) => {
      return path.relative(srcDir, file).split(path.sep).join('/');
    })
    .sort();

  test('every module querying tools or agents is the chokepoint or states why it is not a reference', () => {
    const undeclared = modulesWithLookups.filter((module) => {
      return module !== CHOKEPOINT && !Object.hasOwn(NOT_A_REFERENCE, module);
    });

    assert.deepEqual(undeclared, []);
  });

  test('every declared exception still queries tools or agents', () => {
    const stale = Object.keys(NOT_A_REFERENCE).filter((module) => {
      return !modulesWithLookups.includes(module);
    });

    assert.deepEqual(stale, []);
  });
});
