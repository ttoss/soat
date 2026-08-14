import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * Validates the benchmark solutions dataset
 * (src/data/solutions/*.json) against the schema the /benchmark
 * page depends on. Every file in the directory is validated, so a
 * new solution added by PR is checked even if the author forgets
 * everything else.
 */

const SOLUTIONS_DIR = path.resolve(__dirname, '../src/data/solutions');

const ARCHETYPES = ['managed-platform', 'framework', 'infrastructure'];

const RATINGS = ['native', 'partial', 'plugin', 'absent'];

const CLUSTER_IDS = [
  'agent-runtime',
  'orchestration',
  'knowledge-memory',
  'tools-integration',
  'identity-governance',
  'observability',
  'data-secrets',
  'evaluation',
  'channels',
  'code-execution',
  'human-in-loop',
  'multi-tenancy',
  'declarative-deployment',
  'agent-versioning',
  'skill-learning',
];

const DEPLOYMENTS = ['self-hosted', 'managed'];

const listSolutionFiles = () => {
  return fs
    .readdirSync(SOLUTIONS_DIR)
    .filter((file) => {
      return file.endsWith('.json');
    })
    .sort();
};

test('solutions dataset is non-empty and contains the pinned baseline', () => {
  assert.ok(fs.existsSync(SOLUTIONS_DIR), `missing directory ${SOLUTIONS_DIR}`);
  const files = listSolutionFiles();
  assert.ok(files.length > 0, 'solutions directory has no JSON files');
  // The /benchmark page pins SOAT as the comparison baseline.
  assert.ok(
    files.includes('soat.json'),
    'missing the pinned baseline soat.json'
  );
});

test('every solution file matches the schema', () => {
  const files = listSolutionFiles();
  const slugs = new Set<string>();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(SOLUTIONS_DIR, file), 'utf8');
    const solution = JSON.parse(raw) as Record<string, unknown>;
    const label = `solutions/${file}`;

    assert.equal(
      typeof solution.name,
      'string',
      `${label}: name must be a string`
    );
    assert.equal(
      typeof solution.slug,
      'string',
      `${label}: slug must be a string`
    );
    assert.equal(
      `${String(solution.slug)}.json`,
      file,
      `${label}: slug must match the file name`
    );
    assert.ok(!slugs.has(String(solution.slug)), `${label}: duplicate slug`);
    slugs.add(String(solution.slug));

    assert.ok(
      ARCHETYPES.includes(String(solution.archetype)),
      `${label}: archetype must be one of ${ARCHETYPES.join(', ')}`
    );
    assert.equal(
      typeof solution.summary,
      'string',
      `${label}: summary must be a string`
    );
    assert.match(
      String(solution.website),
      /^https:\/\//,
      `${label}: website must be an https URL`
    );
    assert.equal(
      typeof solution.license,
      'string',
      `${label}: license must be a string`
    );
    assert.match(
      String(solution.last_verified),
      /^\d{4}-\d{2}-\d{2}$/,
      `${label}: last_verified must be an ISO date (YYYY-MM-DD)`
    );

    const deployment = solution.deployment;
    assert.ok(
      Array.isArray(deployment) && deployment.length > 0,
      `${label}: deployment must be a non-empty array`
    );
    for (const mode of deployment as unknown[]) {
      assert.ok(
        DEPLOYMENTS.includes(String(mode)),
        `${label}: deployment entries must be one of ${DEPLOYMENTS.join(', ')}`
      );
    }

    const capabilities = solution.capabilities as Record<string, unknown>;
    assert.ok(
      capabilities && typeof capabilities === 'object',
      `${label}: capabilities must be an object`
    );
    const capabilityKeys = Object.keys(capabilities).sort();
    assert.deepEqual(
      capabilityKeys,
      [...CLUSTER_IDS].sort(),
      `${label}: capabilities must cover exactly the ${CLUSTER_IDS.length} clusters`
    );

    for (const clusterId of CLUSTER_IDS) {
      const capability = capabilities[clusterId] as Record<string, unknown>;
      const capLabel = `${label} capabilities.${clusterId}`;
      assert.ok(
        RATINGS.includes(String(capability.rating)),
        `${capLabel}: rating must be one of ${RATINGS.join(', ')}`
      );
      assert.equal(
        typeof capability.note,
        'string',
        `${capLabel}: note must be a string`
      );
      assert.ok(
        String(capability.note).length > 0,
        `${capLabel}: note must not be empty`
      );
      // Every claim must be sourceable except an explicit absence.
      if (capability.rating !== 'absent') {
        assert.match(
          String(capability.evidence),
          /^https:\/\//,
          `${capLabel}: non-absent ratings require an https evidence URL`
        );
      }
    }
  }
});

test('the page index imports every solution file', () => {
  const indexPath = path.join(SOLUTIONS_DIR, 'index.ts');
  assert.ok(fs.existsSync(indexPath), 'missing src/data/solutions/index.ts');
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  for (const file of listSolutionFiles()) {
    const slug = path.basename(file, '.json');
    assert.ok(
      indexSource.includes(`./${slug}.json`),
      `index.ts does not import ./${slug}.json — the /benchmark page would silently omit it`
    );
  }
});
