import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import type { Solution } from '../src/data/solutions';
import {
  CLUSTERS,
  comparePath,
  PINNED_SLUG,
  solutions,
} from '../src/data/solutions';
import {
  compareDescription,
  compareTitle,
  renderCompareIndex,
  renderComparePage,
} from './comparePages';
import { DESCRIPTION_MAX, DESCRIPTION_MIN, TITLE_MAX } from './seoMetadata';
import { sourcesForPath } from './sitemapLastmod';

const WEBSITE_DIR = path.resolve(__dirname, '..');

/** The suffix the docs theme appends to every doc title. */
const TITLE_SUFFIX = ' | SOAT';

const baseline = solutions.find((solution) => {
  return solution.slug === PINNED_SLUG;
}) as Solution;

const compared = solutions.filter((solution) => {
  return solution.slug !== PINNED_SLUG;
});

const letta = compared.find((solution) => {
  return solution.slug === 'letta';
}) as Solution;

test('every compared solution gets a title a search result shows whole', () => {
  const titles = compared.map((solution) => {
    return `${compareTitle({ solution })}${TITLE_SUFFIX}`;
  });
  for (const title of titles) {
    assert.ok(title.length <= TITLE_MAX, `${title.length}: ${title}`);
  }
  assert.equal(new Set(titles).size, titles.length);
});

test('every compared solution gets its own description inside the bounds', () => {
  const descriptions = compared.map((solution) => {
    return compareDescription({ solution, baseline });
  });
  for (const description of descriptions) {
    assert.ok(
      description.length >= DESCRIPTION_MIN &&
        description.length <= DESCRIPTION_MAX,
      `${description.length}: ${description}`
    );
  }
  assert.equal(new Set(descriptions).size, descriptions.length);
});

test('a comparison page opens with the answer: native coverage on both sides', () => {
  const page = renderComparePage({ solution: letta, baseline });
  const body = page.slice(page.indexOf('# SOAT vs Letta'));
  const firstParagraph = body.split('\n\n')[1];

  const nativeIn = (solution: Solution) => {
    return CLUSTERS.filter((cluster) => {
      return solution.capabilities[cluster.id].rating === 'native';
    }).length;
  };

  assert.match(
    firstParagraph,
    new RegExp(
      `Letta covers ${nativeIn(letta)} natively and SOAT ${nativeIn(baseline)}`
    )
  );
});

test('a comparison page states every capability for both sides, with its source', () => {
  const page = renderComparePage({ solution: letta, baseline });

  for (const cluster of CLUSTERS) {
    assert.ok(page.includes(`### ${cluster.label}`), cluster.label);
    for (const solution of [letta, baseline]) {
      const { evidence } = solution.capabilities[cluster.id];
      if (evidence) {
        assert.ok(
          page.includes(`(${evidence})`),
          `${solution.name} ${cluster.id}`
        );
      }
    }
  }
  assert.ok(page.includes('(/benchmark)'));
});

test('a comparison page escapes MDX in the dataset notes', () => {
  const solution: Solution = {
    ...letta,
    capabilities: {
      ...letta.capabilities,
      'agent-runtime': {
        rating: 'partial',
        note: 'Runs a loop over {state} with <tools>.',
      },
    },
  };
  const page = renderComparePage({ solution, baseline });

  assert.ok(page.includes('Runs a loop over \\{state\\} with \\<tools\\>.'));
});

test('the comparison index links every compared solution', () => {
  const index = renderCompareIndex({ solutions, baseline });

  for (const solution of compared) {
    assert.ok(index.includes(`(./${solution.slug}.md)`), solution.slug);
  }
  assert.ok(!index.includes(`(./${PINNED_SLUG}.md)`));
});

test('a comparison page is dated from the two dataset files it is built from', () => {
  assert.deepEqual(sourcesForPath({ pathname: '/docs/compare/letta' }), [
    'packages/website/src/data/solutions/letta.json',
    'packages/website/src/data/solutions/soat.json',
  ]);
  assert.deepEqual(sourcesForPath({ pathname: '/docs/compare' }), [
    'packages/website/src/data/solutions',
  ]);
});

test('the benchmark links each solution to its comparison page', () => {
  const source = fs.readFileSync(
    path.join(WEBSITE_DIR, 'src/pages/benchmark.tsx'),
    'utf8'
  );

  assert.ok(source.includes('to={comparePath(solution.slug)}'));
  assert.equal(comparePath('letta'), '/docs/compare/letta');
});
