import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

/**
 * Every published package must carry the metadata npm turns into a page:
 * a description, a link back to the canonical domain, and keywords.
 *
 * This is the package-registry twin of docs-lint check 7. The description is
 * what npm, search engines and AI crawlers quote for the package, and the
 * `homepage` is what makes each registry page an inbound link to
 * `soat.ttoss.dev` instead of a dead end.
 *
 * The site's own `Organization` JSON-LD names `npmjs.com/org/soat` in `sameAs`
 * — as evidence that the name "SOAT" belongs to this project. That evidence has
 * to exist: when this check was written, the published `@soat/cli` and
 * `@soat/server` had no description, no homepage and no keywords at all, so the
 * corroborating pages corroborated nothing (ttoss/soat#1099, item 3).
 *
 * The shared phrase matters as much as its presence. "SOAT" collides with the
 * mandatory vehicle-insurance scheme in Colombia, Peru and Ecuador and with the
 * SOAT1/SOAT2 enzymes, so the domain is only findable through qualified
 * queries — and those resolve to one entity only if every property it owns
 * describes itself with the same words.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const PACKAGES_DIR = path.resolve(__dirname, '../../packages');

/** The wording every SOAT-owned property repeats verbatim. */
export const CANONICAL_PHRASE =
  'open-source infrastructure for production-ready AI agents';

/** Where every published package points back to. */
export const CANONICAL_HOMEPAGE = 'https://soat.ttoss.dev';

/** The wording this replaced. Kept only so it can be checked for. */
export const RETIRED_TAGLINE = 'Infrastructure for AI Apps';

/** The files that state what SOAT is to a crawler, a registry, or an agent. */
export const SELF_DESCRIBING_SOURCES = [
  'packages/website/docusaurus.config.ts',
  'packages/server/src/mcp/server.ts',
  'README.md',
];

const readPackages = () => {
  return fs
    .readdirSync(PACKAGES_DIR)
    .map((dir) => {
      return path.join(PACKAGES_DIR, dir, 'package.json');
    })
    .filter((manifest) => {
      return fs.existsSync(manifest);
    })
    .map((manifest) => {
      return JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    });
};

/** Packages that reach the registry — `private` ones are exempt by definition. */
const publishedPackages = () => {
  return readPackages().filter((pkg) => {
    return pkg.private !== true;
  });
};

describe('published package metadata', () => {
  test('there are published packages to check', () => {
    assert.ok(
      publishedPackages().length > 0,
      'no publishable package found — the checks below would pass vacuously'
    );
  });

  test('every published package describes itself with the canonical phrase', () => {
    const offenders = publishedPackages()
      .filter((pkg) => {
        return (
          typeof pkg.description !== 'string' ||
          !pkg.description.includes(CANONICAL_PHRASE)
        );
      })
      .map((pkg) => {
        return `${pkg.name}: ${pkg.description ?? '(no description)'}`;
      });

    assert.deepEqual(offenders, []);
  });

  test('every published package links the canonical domain', () => {
    const offenders = publishedPackages()
      .filter((pkg) => {
        return pkg.homepage !== CANONICAL_HOMEPAGE;
      })
      .map((pkg) => {
        return `${pkg.name}: ${pkg.homepage ?? '(no homepage)'}`;
      });

    assert.deepEqual(offenders, []);
  });

  test('every published package names its source directory', () => {
    const offenders = publishedPackages()
      .filter((pkg) => {
        return (
          typeof pkg.repository !== 'object' ||
          pkg.repository === null ||
          typeof pkg.repository.url !== 'string' ||
          typeof pkg.repository.directory !== 'string'
        );
      })
      .map((pkg) => {
        return `${pkg.name}: ${JSON.stringify(pkg.repository ?? null)}`;
      });

    assert.deepEqual(offenders, []);
  });

  test('the retired "AI Apps" tagline does not come back', () => {
    // The project described itself four different ways at once — "AI Apps" in
    // the site tagline and the llms.txt/MCP descriptions, "AI agents" in the
    // README and the design system. Search engines quoted whichever they found.
    // The wording is settled now (see `.claude/rules/website.md`); this keeps a
    // copy of the old one from drifting back into a surface nobody re-reads.
    const offenders = SELF_DESCRIBING_SOURCES.filter((file) => {
      const full = path.resolve(__dirname, '../..', file);
      return (
        fs.existsSync(full) &&
        fs.readFileSync(full, 'utf-8').includes(RETIRED_TAGLINE)
      );
    });

    assert.deepEqual(offenders, []);
  });

  test('every published package carries keywords', () => {
    const offenders = publishedPackages()
      .filter((pkg) => {
        return !Array.isArray(pkg.keywords) || pkg.keywords.length === 0;
      })
      .map((pkg) => {
        return pkg.name;
      });

    assert.deepEqual(offenders, []);
  });
});
