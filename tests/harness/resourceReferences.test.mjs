import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const CHOKEPOINT = 'lib/resourceReferences.ts';

/** Source with comments dropped, so prose naming a model is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const walk = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

const SOURCES = walk(srcDir).map((file) => {
  return {
    module: path.relative(srcDir, file).split(path.sep).join('/'),
    text: code(file),
  };
});

/**
 * A direct query on one of `models`, or the model handed to a generic lookup —
 * never an `include` entry, which names its association with `as`.
 */
const lookupPattern = (models) => {
  const names = models.join('|');
  return new RegExp(
    `\\bdb\\.(${names})\\.(findOne|findAll|findByPk|findAndCountAll)\\b|\\bmodel:\\s*db\\.(${names})\\s*,(?!\\s*as:)`
  );
};

/**
 * A resource named by id in a stored field, or in a request that runs it,
 * resolves in `lib/resourceReferences.ts`: in the project of the row that holds
 * the reference, and nowhere else. A module querying the model itself is either
 * that module or one listed with the reason its lookup is not a reference, so a
 * new lookup states which it is instead of re-deriving the scope rule by hand.
 */
const pinReferences = (args) => {
  const { label, models, notAReference } = args;

  describe(`${label} references`, () => {
    const lookup = lookupPattern(models);
    const modulesWithLookups = SOURCES.filter((source) => {
      return lookup.test(source.text);
    })
      .map((source) => {
        return source.module;
      })
      .sort();

    test(`every module querying ${label} is the chokepoint or states why it is not a reference`, () => {
      const undeclared = modulesWithLookups.filter((module) => {
        return module !== CHOKEPOINT && !Object.hasOwn(notAReference, module);
      });

      assert.deepEqual(undeclared, []);
    });

    test(`every declared ${label} exception still queries it`, () => {
      const stale = Object.keys(notAReference).filter((module) => {
        return !modulesWithLookups.includes(module);
      });

      assert.deepEqual(stale, []);
    });
  });
};

pinReferences({
  label: 'tool and agent',
  models: ['Tool', 'Agent'],
  /** Module → why its `Tool`/`Agent` query is not a by-id reference. */
  notAReference: {
    'lib/actorFilters.ts': 'narrows a listing already scoped to the caller',
    'lib/agentNonStreamGeneration.ts':
      "reads tools by name inside the running agent's project",
    'lib/agents.ts': "lists the caller's agents",
    'lib/agentVersions.ts': "the agent's own version routes",
    'lib/aiProviderDeletion.ts': "lists a provider's dependents",
    'lib/completionModel.ts':
      'reads back the internal id of an agent already resolved',
    'lib/generationProvenance.ts':
      'reads the trust of a tool an approved call already ran',
    'lib/guardrailDryRun.ts': 'reads a display name for a report',
    'lib/guardrailRuntimeMetrics.ts': 'reads display names for a report',
    'lib/guardrails.ts': "lists a project's tools and agents",
    'lib/ingestionRuleRefs.ts':
      'reads the type of a converter already resolved to an internal id',
    'lib/knowledgeConfigBackfill.ts': 'a schema backfill over every row',
    'lib/mcpDefinitionPins.ts':
      'reads back the pins of a tool already resolved for the turn',
    'lib/memoryRules.ts':
      'reads the type of a handler already resolved to an internal id',
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
    'lib/shareReferenceVersions.ts':
      "finds a grantee's versions naming a shared resource",
    'lib/tools.ts': "lists the caller's tools",
    'lib/traceContentPolicy.ts': "reads the running agent's own policy",
    'lib/usageGenerationAttribution.ts':
      "reads a generation's own agent to name its publisher",
    'lib/usageToolRecording.ts': 'maps a metered call to its internal ids',
    'lib/writerRule.ts':
      'reads the public id of a target already resolved to an internal id',
  },
});

pinReferences({
  label: 'AI provider',
  models: ['AiProvider'],
  /** Module → why its `AiProvider` query is not a by-id reference. */
  notAReference: {
    'lib/aiProviderAliasTargets.ts':
      'scans a project for the providers whose aliases forward to one',
    'lib/aiProviderModels.ts': "reads the project of the route's own provider",
    'lib/aiProviderDeletion.ts': "deletes the route's own provider",
    'lib/aiProviders.ts': "lists the caller's providers",
    'lib/chatCompletionModel.ts':
      "reads the project of the route's own provider",
    'lib/modelRouteAttribution.ts':
      'reads back the provider a routed turn already resolved',
    'lib/priceBook.ts':
      "reads the price route's own provider, or an operator's global row",
    'lib/scopedIdFilters.ts': 'narrows a listing already scoped to the caller',
    'lib/shareableTypes.ts': 'the publisher reading its own resource',
  },
});
