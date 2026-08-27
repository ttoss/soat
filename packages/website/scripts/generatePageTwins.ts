/**
 * Generates the Markdown twin of every Markdown page under `src/pages`:
 *
 *   src/pages/about.md  ->  static/about.md  (served at /about.md)
 *
 * The docs tree gets its twins from `docusaurus-plugin-llms`, which never sees
 * `src/pages`. Without this step a standalone page has an HTML representation
 * and no Markdown one — and the CloudFront viewer request function, which
 * cannot check whether a file exists, rewrites `Accept: text/markdown` on
 * `/about` to `/about.md` and serves a 404. Declaring such a page HTML-only
 * would be the other way out, but these pages are prose an agent has every
 * reason to want as Markdown.
 *
 * The page file is the single source: the twin is the same bytes with the
 * Docusaurus front matter removed.
 *
 * Run with: pnpm tsx scripts/generatePageTwins.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const PAGES_DIR = path.resolve(__dirname, '../src/pages');

const STATIC_DIR = path.resolve(__dirname, '../static');

/**
 * The page source without its front matter block, so the twin opens on the
 * `# Heading` an agent reads as the document title rather than on YAML.
 *
 * Only a block that opens on the very first line counts — a `---` rule further
 * down is body content, not a delimiter.
 */
export const stripFrontMatter = (args: { source: string }): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/.exec(args.source);
  return match ? args.source.slice(match[0].length) : args.source;
};

/** The twin file published for a page, named after the page's own route. */
export const twinFileName = (args: { pageName: string }): string => {
  return `${args.pageName}.md`;
};

/** Every Markdown page under `src/pages`, by route name. */
export const markdownPageNames = (): string[] => {
  return fs
    .readdirSync(PAGES_DIR)
    .filter((entry) => {
      return entry.endsWith('.md') || entry.endsWith('.mdx');
    })
    .map((entry) => {
      return path.basename(entry, path.extname(entry));
    })
    .sort();
};

const generate = (): void => {
  fs.mkdirSync(STATIC_DIR, { recursive: true });

  const written = markdownPageNames().map((pageName) => {
    const source = fs.existsSync(path.join(PAGES_DIR, `${pageName}.md`))
      ? path.join(PAGES_DIR, `${pageName}.md`)
      : path.join(PAGES_DIR, `${pageName}.mdx`);

    const twin = twinFileName({ pageName });

    fs.writeFileSync(
      path.join(STATIC_DIR, twin),
      stripFrontMatter({ source: fs.readFileSync(source, 'utf-8') }),
      'utf-8'
    );

    return twin;
  });

  process.stdout.write(
    `[page-twins] wrote ${written.length} Markdown twins: ${written.join(', ')}\n`
  );
};

// Importing this module — as the test does — must not write anything; only
// running it as a script generates.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  generate();
}
