/**
 * Generates packages/website/docs/compare/: one page per benchmark solution
 * read against SOAT, and an index, from src/data/solutions.
 *
 * Run with: pnpm tsx scripts/generateComparePages.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import type { Solution } from '../src/data/solutions';
import { PINNED_SLUG, solutions } from '../src/data/solutions';
import { renderCompareIndex, renderComparePage } from './comparePages';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const OUTPUT_DIR = path.resolve(__dirname, '../docs/compare');

const baseline = solutions.find((solution): solution is Solution => {
  return solution.slug === PINNED_SLUG;
});

if (!baseline) {
  throw new Error(`No benchmark solution has the slug "${PINNED_SLUG}".`);
}

fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'index.md'),
  renderCompareIndex({ solutions, baseline })
);

const compared = solutions.filter((solution) => {
  return solution.slug !== PINNED_SLUG;
});

for (const solution of compared) {
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${solution.slug}.md`),
    renderComparePage({ solution, baseline })
  );
}

// eslint-disable-next-line no-console
console.log(
  `Generated ${path.relative(process.cwd(), OUTPUT_DIR)} (${compared.length} comparisons)`
);
