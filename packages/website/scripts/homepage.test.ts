import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HERO, NOT_WIRED, QUICKSTART_COMMANDS } from '../src/data/homepage';
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

/** How SOAT is built: the call-flow band draws it, so the hero never has to. */
const ARCHITECTURE_TERMS = ['PostgreSQL', 'pgvector', 'Node.js', 'process'];

const readComponent = (file: string): string => {
  return fs.readFileSync(path.join(COMPONENTS_DIR, file), 'utf8');
};

test('the hero says what an agent gets, not how SOAT is built', () => {
  const copy = [HERO.title, HERO.emphasis, HERO.subtitle].join(' ');
  const named = ARCHITECTURE_TERMS.filter((term) => {
    return copy.includes(term);
  });

  assert.deepEqual(named, [], 'the hero copy names the architecture');
  assert.ok(
    readComponent(path.join('HomepageHero', 'index.tsx')).includes('HERO.title')
  );
});

test('the stack SOAT replaces is listed where the call flow is drawn', () => {
  assert.ok(NOT_WIRED.length > 0);
  assert.ok(
    readComponent(path.join('HomepageDefinition', 'index.tsx')).includes(
      'NOT_WIRED'
    )
  );
  assert.ok(
    !readComponent(path.join('HomepageHero', 'index.tsx')).includes(
      'NOT_WIRED'
    ),
    'the hero lists the services SOAT replaces; that detail belongs to the call-flow band'
  );
});
