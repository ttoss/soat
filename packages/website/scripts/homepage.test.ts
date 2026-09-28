import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { QUICKSTART_COMMANDS } from '../src/data/homepage';
import {
  capabilityRows,
  CLUSTERS,
  PINNED_SLUG,
  solutions,
} from '../src/data/solutions';

const COMPONENTS_DIR = path.resolve(__dirname, '../src/components');

const PRIMARY_ACTION_FILE = path.join('HomepageShared', 'PrimaryAction.tsx');

const homepageSources = (): string[] => {
  return fs
    .readdirSync(COMPONENTS_DIR)
    .filter((entry) => {
      return entry.startsWith('Homepage');
    })
    .flatMap((entry) => {
      return fs
        .readdirSync(path.join(COMPONENTS_DIR, entry))
        .filter((file) => {
          return file.endsWith('.tsx');
        })
        .map((file) => {
          return path.join(entry, file);
        });
    });
};

test('the homepage has one primary action, rendered by PrimaryAction', () => {
  const offenders = homepageSources().filter((file) => {
    if (file === PRIMARY_ACTION_FILE) return false;
    const source = fs.readFileSync(path.join(COMPONENTS_DIR, file), 'utf8');
    return source.includes('button--primary');
  });

  assert.deepEqual(
    offenders,
    [],
    'a homepage band styles its own primary button; render <PrimaryAction /> so every band leads to the same action'
  );

  const shared = fs.readFileSync(
    path.join(COMPONENTS_DIR, PRIMARY_ACTION_FILE),
    'utf8'
  );
  assert.ok(shared.includes('PRIMARY_ACTION'));
});

test('the quick-start terminal blocks on the generation it shows the answer of', () => {
  const generate = QUICKSTART_COMMANDS.find((command) => {
    return command.lines[0].startsWith('soat generate-session-response');
  });

  assert.ok(generate, 'the terminal no longer generates a response');
  // Without `--wait true` the endpoint answers 202 and runs in the
  // background, so the reply the terminal promises never prints.
  assert.ok(
    generate.lines.join(' ').includes('--wait true'),
    'generate-session-response without --wait true returns 202, not the reply'
  );
});

test('capability rows put the baseline first and follow the cluster order', () => {
  const rows = capabilityRows(solutions);

  assert.equal(rows.length, solutions.length);
  assert.equal(rows[0].slug, PINNED_SLUG);

  for (const row of rows) {
    const solution = solutions.find((candidate) => {
      return candidate.slug === row.slug;
    });
    assert.ok(solution);
    assert.deepEqual(
      row.ratings.map((cell) => {
        return cell.clusterId;
      }),
      CLUSTERS.map((cluster) => {
        return cluster.id;
      })
    );
    for (const cell of row.ratings) {
      assert.equal(cell.rating, solution.capabilities[cell.clusterId].rating);
    }
    assert.equal(
      row.nativeCount,
      row.ratings.filter((cell) => {
        return cell.rating === 'native';
      }).length
    );
  }
});

const SITE_ROOT = path.resolve(__dirname, '..');
const VECTOR_GALAXY_FILE = path.join(
  'src',
  'components',
  'VectorGalaxy',
  'index.tsx'
);
const GALAXY_BITMAP = 'soat-logo-no-bg.png';

const siteSources = (dir: string): string[] => {
  return fs
    .readdirSync(path.join(SITE_ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) return siteSources(relative);
      return /\.(tsx?|css)$/.test(entry.name) ? [relative] : [];
    });
};

test('the Vector Galaxy is drawn only by VectorGalaxy', () => {
  const offenders = [...siteSources('src'), 'docusaurus.config.ts'].filter(
    (file) => {
      if (file === VECTOR_GALAXY_FILE) return false;
      return fs
        .readFileSync(path.join(SITE_ROOT, file), 'utf8')
        .includes(GALAXY_BITMAP);
    }
  );

  assert.deepEqual(
    offenders,
    [],
    'a component draws the galaxy bitmap itself; render <VectorGalaxy /> so every placement shares the in-plane rotation and its reduced-motion rule'
  );
});
