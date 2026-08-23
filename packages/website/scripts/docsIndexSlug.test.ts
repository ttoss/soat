import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const DOCS_DIR = path.resolve(__dirname, '../docs');

/**
 * Every folder-index doc (`<folder>/index.md`) must declare an absolute,
 * slash-less `slug`.
 *
 * Without one, Docusaurus routes the doc at `/docs/<folder>/` — with a
 * trailing slash — while every internal link, the rest of the site, and
 * therefore every URL Google crawls use `/docs/<folder>`. Both forms answer
 * `200` behind CloudFront (`appendIndexHtml`), so the two spellings are one
 * page reachable at two URLs whose `rel=canonical`, `og:url`, `hreflang` and
 * sitemap entry all point at the form nothing links to. Search Console reports
 * that as "Duplicate, Google chose different canonical than user".
 */
const findIndexDocs = (dir: string): string[] => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return findIndexDocs(full);
    }
    return entry.name === 'index.md' || entry.name === 'index.mdx'
      ? [full]
      : [];
  });
};

const readSlug = (file: string): string | undefined => {
  const content = fs.readFileSync(file, 'utf-8');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  return /^slug:\s*(\S+)\s*$/m.exec(frontmatter ?? '')?.[1];
};

test('every folder-index doc declares a slash-less absolute slug', () => {
  const indexDocs = findIndexDocs(DOCS_DIR);

  assert.ok(indexDocs.length > 0, 'expected at least one folder-index doc');

  for (const file of indexDocs) {
    const relative = path.relative(DOCS_DIR, file);
    const folder = path.dirname(relative);
    const slug = readSlug(file);

    assert.equal(
      slug,
      `/${folder}`,
      `${relative} must declare \`slug: /${folder}\` so its route is ` +
        `/docs/${folder} (no trailing slash), matching the form every ` +
        `internal link uses`
    );
  }
});
