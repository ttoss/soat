import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PENDING_CONTRACTIONS } from '../../packages/postgresdb/src/migrations/pendingContractions.ts';

/**
 * `.claude/rules/postgresdb.md` § Every migration keeps the previous release
 * working: an expand is registered in `PENDING_CONTRACTIONS` until its contract
 * merges, and the contract ships in the release right after the expand.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS_DIR = 'packages/postgresdb/src/migrations';
const MARKER = /expand-contract: (\d{4}-\d{2}-\d{2}-[a-z0-9-]+)/g;

const git = (args) => {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
};

/** Migration `name` → its file, relative to the repository root. */
const migrationFiles = () => {
  const byName = new Map();
  for (const file of fs.readdirSync(path.join(repoRoot, MIGRATIONS_DIR))) {
    const relative = `${MIGRATIONS_DIR}/${file}`;
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    for (const match of source.matchAll(/^\s+name: '([^']+)'/gm)) {
      byName.set(match[1], relative);
    }
  }
  return byName;
};

/** Published versions, newest first; the first is `lerna.json`'s. */
const publishedVersions = () => {
  const changelog = fs.readFileSync(
    path.join(repoRoot, 'CHANGELOG.md'),
    'utf8'
  );
  return [...changelog.matchAll(/^#{1,2} \[(\d+\.\d+\.\d+)\]/gm)].map(
    (match) => {
      return match[1];
    }
  );
};

/**
 * The migration files a published release carries. A shallow checkout (CI)
 * lacks the tag, so it is fetched on a miss; anything else fails closed.
 */
const migrationFilesInRelease = (version) => {
  const tag = `v${version}`;
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch {
    const shallow =
      git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
    git([
      'fetch',
      '--quiet',
      '--no-tags',
      ...(shallow ? ['--depth=1'] : []),
      'origin',
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
  }
  return new Set(
    git(['ls-tree', '-r', '--name-only', tag, '--', MIGRATIONS_DIR])
      .split('\n')
      .filter(Boolean)
  );
};

/** Every `expand-contract: <name>` marker outside the migrations. */
const markers = () => {
  let output;
  try {
    output = git([
      'grep',
      '-n',
      '-I',
      '-E',
      'expand-contract: [0-9]{4}-',
      '--',
      'packages',
      `:!${MIGRATIONS_DIR}`,
    ]);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return output
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const file = line.slice(0, line.indexOf(':'));
      return [...line.matchAll(MARKER)].map((match) => {
        return { file, expand: match[1] };
      });
    });
};

/**
 * Entries whose expand shipped in a release before the latest. Migrations are
 * never deleted, so one in the previous release's tree shipped there or earlier.
 */
export const overdueContractions = (args) => {
  return args.entries.filter((entry) => {
    return args.shippedBeforeLatest.has(args.migrationFileOf.get(entry.expand));
  });
};

/** Where the registry and the markers in code disagree. */
export const registryMismatches = (args) => {
  const problems = [];
  const byExpand = new Map();
  for (const entry of args.entries) {
    if (byExpand.has(entry.expand)) {
      problems.push(`${entry.expand}: registered twice`);
    }
    byExpand.set(entry.expand, entry);
    if (!args.migrationFileOf.has(entry.expand)) {
      problems.push(`${entry.expand}: no migration has this name`);
    }
    for (const file of entry.shims) {
      const marked = args.markers.some((marker) => {
        return marker.file === file && marker.expand === entry.expand;
      });
      if (!marked) {
        problems.push(`${entry.expand}: ${file} carries no marker`);
      }
    }
  }
  for (const marker of args.markers) {
    const entry = byExpand.get(marker.expand);
    if (!entry || !entry.shims.includes(marker.file)) {
      problems.push(
        `${marker.file}: marker for ${marker.expand} is not in PENDING_CONTRACTIONS`
      );
    }
  }
  return problems;
};

describe('pending contractions', () => {
  test('the latest release is the one lerna.json names', () => {
    const lerna = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'lerna.json'), 'utf8')
    );
    assert.equal(publishedVersions()[0], lerna.version);
  });

  test('no contract is overdue', () => {
    const [, previous] = publishedVersions();
    const overdue = overdueContractions({
      entries: PENDING_CONTRACTIONS,
      migrationFileOf: migrationFiles(),
      shippedBeforeLatest: migrationFilesInRelease(previous),
    });
    assert.deepEqual(
      overdue.map((entry) => {
        return entry.expand;
      }),
      [],
      'an expand shipped in a release before the latest: merge its contract (drop the old shape, delete every marked line, remove the entry)'
    );
  });

  test('the registry and the code markers agree', () => {
    assert.deepEqual(
      registryMismatches({
        entries: PENDING_CONTRACTIONS,
        migrationFileOf: migrationFiles(),
        markers: markers(),
      }),
      []
    );
  });
});

describe('pending contraction checks on fixtures', () => {
  test('an expand shipped before the latest release is overdue', () => {
    const [, previous] = publishedVersions();
    const fixture = {
      expand: '2026-09-11-memory-tags-to-jsonb',
      oldShape: 'memories.tags text[]',
      shims: [],
    };
    assert.deepEqual(
      overdueContractions({
        entries: [fixture],
        migrationFileOf: migrationFiles(),
        shippedBeforeLatest: migrationFilesInRelease(previous),
      }),
      [fixture]
    );
  });

  test('an expand not yet in a release before the latest is not overdue', () => {
    assert.deepEqual(
      overdueContractions({
        entries: [{ expand: '2026-12-01-fixture', oldShape: 'x', shims: [] }],
        migrationFileOf: new Map([
          ['2026-12-01-fixture', `${MIGRATIONS_DIR}/2026-12-01-fixture.ts`],
        ]),
        shippedBeforeLatest: new Set(),
      }),
      []
    );
  });

  test('a marker without an entry, and an entry without its marker, both fail', () => {
    const migrationFileOf = new Map([['2026-12-01-fixture', 'm.ts']]);
    assert.deepEqual(
      registryMismatches({
        entries: [],
        migrationFileOf,
        markers: [{ file: 'a.ts', expand: '2026-12-01-fixture' }],
      }),
      ['a.ts: marker for 2026-12-01-fixture is not in PENDING_CONTRACTIONS']
    );
    assert.deepEqual(
      registryMismatches({
        entries: [
          { expand: '2026-12-01-fixture', oldShape: 'x', shims: ['a.ts'] },
        ],
        migrationFileOf,
        markers: [],
      }),
      ['2026-12-01-fixture: a.ts carries no marker']
    );
  });
});

describe('schema sync never drops a column', () => {
  test('every sync in src runs with SCHEMA_SYNC_OPTIONS', () => {
    let output = '';
    try {
      output = git([
        'grep',
        '-n',
        '-E',
        'alter: ?true',
        '--',
        ':(glob)packages/*/src/**',
      ]);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    const code = output.split('\n').filter((line) => {
      const text = line.split(':').slice(2).join(':').trim();
      return text !== '' && !text.startsWith('*') && !text.startsWith('//');
    });
    assert.deepEqual(
      code,
      [],
      'sync with SCHEMA_SYNC_OPTIONS (@soat/postgresdb): a column leaves only through a contract migration'
    );
  });
});
