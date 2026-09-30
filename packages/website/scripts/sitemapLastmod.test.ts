import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT, sourcesForPath, withLastmod } from './sitemapLastmod';

const SPECS_DIR = path.join(REPO_ROOT, 'packages/server/src/rest/openapi/v1');

const specSlugs = fs
  .readdirSync(SPECS_DIR)
  .filter((file) => {
    return file.endsWith('.yaml');
  })
  .map((file) => {
    return file.replace(/\.yaml$/, '');
  });

test('every generated reference page maps to the spec it is generated from', () => {
  for (const slug of specSlugs) {
    for (const pathname of [
      `/docs/api/${slug}/some-operation`,
      `/docs/sdk/services/${slug}`,
      `/docs/mcp/tools/${slug}`,
      `/docs/cli/commands/${slug}`,
    ]) {
      assert.deepEqual(
        sourcesForPath({ pathname }),
        [`packages/server/src/rest/openapi/v1/${slug}.yaml`],
        pathname
      );
    }
  }
});

test('every source a page maps to exists in the repository', () => {
  const pathnames = [
    '/',
    '/benchmark',
    '/about',
    '/privacy',
    '/docs/api',
    '/docs/permissions',
    '/docs/error-codes',
    '/docs/webhook-events',
    '/docs/openapi-specs',
    '/docs/formations-types',
    '/docs/formations-types/agent',
    '/docs/compare',
    '/docs/compare/letta',
    '/docs/sdk/services',
    '/docs/mcp/tools',
    '/docs/cli/commands',
  ];
  for (const pathname of pathnames) {
    const sources = sourcesForPath({ pathname });
    assert.ok(sources.length > 0, `${pathname} maps to no source`);
    for (const source of sources) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, source)),
        `${pathname} → ${source}`
      );
    }
  }
});

test('withLastmod fills only the items that have no date, from their sources', () => {
  const items = withLastmod({
    items: [
      {
        url: 'https://soat.ttoss.dev/docs/modules/agents',
        lastmod: '2026-01-02T00:00:00.000Z',
      },
      {
        url: 'https://soat.ttoss.dev/docs/api/agents/get-agent',
        lastmod: null,
      },
      { url: 'https://soat.ttoss.dev/somewhere-unmapped' },
    ],
    lastmodOf: (sources) => {
      return sources.length > 0 ? `date of ${sources.join(',')}` : undefined;
    },
  });

  assert.deepEqual(
    items.map((item) => {
      return item.lastmod;
    }),
    [
      '2026-01-02T00:00:00.000Z',
      'date of packages/server/src/rest/openapi/v1/agents.yaml',
      undefined,
    ]
  );
});
