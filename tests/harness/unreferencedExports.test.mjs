import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The packages whose exports only their own workspace consumes. */
const EXPORTING_ROOTS = ['packages/server/src', 'packages/postgresdb/src'];

/** Where a reference may come from. */
const READING_ROOTS = ['packages', 'scripts', 'tests'];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', '.docusaurus']);

/**
 * Exports only tests reach: a reset, flush or probe a test drives because no
 * request can. An entry leaves once production code reads the name, or once
 * the seam goes.
 */
const TEST_SEAMS = [
  'packages/postgresdb/src/migrations/pendingContractions.ts PENDING_CONTRACTIONS',
  'packages/server/src/lib/aiProviderModels.ts isModelListingSupported',
  'packages/server/src/lib/auditQueue.ts flushAuditQueue',
  'packages/server/src/lib/auditQueue.ts getDroppedAuditCount',
  'packages/server/src/lib/auditQueue.ts resetAuditQueue',
  'packages/server/src/lib/builtinActionCatalog.ts resetBuiltinActionCatalog',
  'packages/server/src/lib/eventBus.ts droppedEventCount',
  'packages/server/src/lib/fileStorage.ts resetStorageProviders',
  'packages/server/src/lib/formationsRegistry.ts builtInResourceTypes',
  'packages/server/src/lib/formationsRegistry.ts enableFormationResourceTypes',
  'packages/server/src/lib/formationsRegistry.ts unregisterFormationResourceTypes',
  'packages/server/src/lib/generationWakeup.ts closeGenerationWakeup',
  'packages/server/src/lib/iamRegistrations.ts loadIamRegistrationConfig',
  'packages/server/src/lib/iamRegistrations.ts unregisterIamModules',
  'packages/server/src/lib/mcpToolRegistrations.ts unregisterMcpTools',
  'packages/server/src/lib/modelRouteBreaker.ts resetModelRouteBreakers',
  'packages/server/src/lib/openapiSpec.ts getRequestSchemaFields',
  'packages/server/src/lib/openapiSpec.ts getRouteRequestSchemaFields',
  'packages/server/src/lib/orchestration-queue-drivers/index.ts resetOrchestrationQueueDriver',
  'packages/server/src/lib/orchestrationQueueMetrics.ts resetClaimLatencyRing',
  'packages/server/src/lib/orchestrationWorker.ts resetLastSuccessfulDrain',
  'packages/server/src/lib/pagination.ts DEFAULT_LIST_LIMIT',
  'packages/server/src/lib/pagination.ts MAX_LIST_LIMIT',
  'packages/server/src/lib/principals.ts PrincipalType',
  'packages/server/src/lib/runStatus.ts RUN_STATUSES',
  'packages/server/src/lib/projectDependents.ts PROJECT_PARENT_SCOPED_MODELS',
  'packages/server/src/lib/projectPauseActions.ts flushProjectResumes',
  'packages/server/src/lib/tasks.ts flushTaskAutomations',
  'packages/server/src/lib/toolEgress.ts assertEgressAllowed',
  'packages/server/src/lib/traceContentPolicy.ts GENERATION_PROGRESS_COLUMNS',
  'packages/server/src/lib/usageRequests.ts resetRequestCounters',
  'packages/server/src/lib/vertexAwsCredentials.ts resetAwsExternalAccountAuthClientCache',
];

const sourceFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(c|m)?(j|t)sx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

const isTest = (file) => {
  return /(^|\/)tests?\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);
};

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Every identifier-shaped word in each file, comments blanked. */
const wordCounts = () => {
  const counts = new Map();
  for (const root of READING_ROOTS) {
    for (const full of sourceFiles(path.join(repoRoot, root))) {
      const file = path.relative(repoRoot, full);
      const tally = new Map();
      const code = stripComments(fs.readFileSync(full, 'utf-8'));
      for (const [word] of code.matchAll(IDENTIFIER)) {
        tally.set(word, (tally.get(word) ?? 0) + 1);
      }
      counts.set(file, tally);
    }
  }
  return counts;
};

/**
 * Each exported name with the occurrences its own declaration accounts for:
 * one for `export const x`, two for `const x` re-listed in `export { x }`.
 */
const exportsOf = (code) => {
  const found = [];
  for (const match of code.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    found.push({ name: match[1], declared: 1 });
  }
  for (const match of code.matchAll(/^export\s+(?:type\s+)?{([^}]*)}\s*;/gm)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name) found.push({ name, declared: 2 });
    }
  }
  return found;
};

/** Exports no production file reads, as `<file> <name>` with who reads them. */
const unreferencedExports = () => {
  const counts = wordCounts();
  const result = [];
  for (const root of EXPORTING_ROOTS) {
    for (const full of sourceFiles(path.join(repoRoot, root))) {
      const file = path.relative(repoRoot, full);
      const code = stripComments(fs.readFileSync(full, 'utf-8'));
      for (const { name, declared } of exportsOf(code)) {
        if (counts.get(file).get(name) > declared) continue;
        const readers = [...counts.keys()].filter((other) => {
          return other !== file && counts.get(other).has(name);
        });
        if (
          readers.some((reader) => {
            return !isTest(reader);
          })
        )
          continue;
        result.push({ key: `${file} ${name}`, testOnly: readers.length > 0 });
      }
    }
  }
  return result;
};

describe('unreferenced exports', () => {
  const found = unreferencedExports();

  test('every export is read by production code or is a listed test seam', () => {
    const unlisted = found
      .filter(({ key, testOnly }) => {
        return !testOnly || !TEST_SEAMS.includes(key);
      })
      .map(({ key, testOnly }) => {
        return `${key}${testOnly ? ' (tests only: add to TEST_SEAMS or drop the export)' : ' (read nowhere: delete it)'}`;
      });
    assert.deepEqual(unlisted, []);
  });

  test('TEST_SEAMS names only exports nothing but tests reads', () => {
    const testOnly = new Set(
      found
        .filter(({ testOnly: only }) => {
          return only;
        })
        .map(({ key }) => {
          return key;
        })
    );
    const stale = TEST_SEAMS.filter((key) => {
      return !testOnly.has(key);
    });
    assert.deepEqual(stale, []);
  });
});
