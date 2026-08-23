/**
 * Puts the Markdown twin of every page at `<page>.md`, and advertises it in the
 * page itself.
 *
 * `docusaurus-plugin-llms` emits a Markdown file per generated page, but
 * nothing in the HTML says so, which leaves an agent guessing. This step adds
 * the RFC 8288 link relation that names it:
 *
 *   <link rel="alternate" type="text/markdown" href="/docs/introduction.md"/>
 *
 * It runs over the emitted files after `docusaurus build`, so it covers every
 * page — including the generated API reference — without swizzling a theme
 * component per route type. It deliberately is not a plugin: `postBuild` hooks
 * do not run strictly after `docusaurus-plugin-llms` has written the `.md`
 * files this step looks for.
 *
 * Run with: pnpm tsx scripts/advertiseMarkdownTwins.ts [buildDir]
 *
 * The plugin does not write every twin at `<page>.md`: a folder-index page
 * gets `<page>/<docId>.md`, and a page under a route base path gets the path
 * without that prefix. Twins are therefore normalized first — copied, never
 * moved, since the URLs the plugin published are linked from `llms.txt` — and
 * a redirect stub, whose only content is where the page went, gets a twin
 * saying so.
 *
 * That one rule, `<page>.md`, is what the other half depends on: negotiation
 * on the *same* URL — the four acceptmarkdown.com criteria — runs at the edge
 * in `cloudfront/viewerRequest.js`, which maps an `Accept` preferring
 * `text/markdown` onto the twin, answers `406` when a page request accepts
 * neither representation, and orders the two by q-value, while the
 * `vary: Accept` response header in `carlin.yml` tells caches which header
 * decided. The edge cannot test whether a file exists, so it applies the rule
 * blind; `scripts/viewerRequest.test.ts` negotiates every built page against
 * the build and fails on any that would resolve to a file this step did not
 * produce.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

export type MarkdownTwin = {
  /** Path of the Markdown file relative to the build output root. */
  markdownRelativePath: string;
  /** Site-absolute URL of the Markdown file. */
  href: string;
};

/**
 * The Markdown twin of a built HTML file, or `null` when the file is not a
 * page directory (`index.html` at the root, …) and therefore has no
 * `<page>.md` sibling. `404.html` is the one special case — see below.
 */
export const markdownTwinOf = (args: {
  htmlRelativePath: string;
}): MarkdownTwin | null => {
  const normalized = args.htmlRelativePath.split(path.sep).join('/');

  // The 404 page is the one page whose Markdown twin is not derived from its
  // own path: Docusaurus emits it as a bare `404.html`, and its twin is the
  // generated recovery map. It is also the page that needs the pointer most —
  // an agent lands there precisely when it has lost the thread.
  if (normalized === '404.html') {
    return { markdownRelativePath: '404.md', href: '/404.md' };
  }

  if (!normalized.endsWith('/index.html')) return null;

  const withoutIndex = normalized.slice(0, -'/index.html'.length);
  if (withoutIndex.length === 0) return null;

  return {
    markdownRelativePath: `${withoutIndex}.md`,
    href: `/${withoutIndex}.md`,
  };
};

const htmlFilesIn = (root: string, current = root): string[] => {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) return htmlFilesIn(root, absolute);
    return entry.name.endsWith('.html') ? [path.relative(root, absolute)] : [];
  });
};

/**
 * The target of a `@docusaurus/plugin-client-redirects` stub, whose whole body
 * is a meta refresh and a canonical link, or `null` for a real page.
 */
export const redirectTargetOf = (args: { html: string }): string | null => {
  const match =
    /<meta\s+http-equiv="refresh"\s+content="[^"]*url=([^"]+)"/i.exec(
      args.html
    );

  return match ? match[1].trim() : null;
};

/**
 * Where the llms plugin may have written a page's Markdown, in the order the
 * paths are tried. `<page>.md` is the destination as well as the first
 * candidate, so a page already normalized costs one `existsSync`.
 */
const twinCandidatesOf = (args: { pagePath: string }): string[] => {
  const { pagePath } = args;
  const basename = pagePath.slice(pagePath.lastIndexOf('/') + 1);
  const segments = pagePath.split('/');

  return [
    `${pagePath}.md`,
    // A folder-index page: named after its doc id, inside the page directory.
    `${pagePath}/${basename}.md`,
    // A page under a route base path (`/docs/mcp/tools/agents` →
    // `mcp/tools/agents.md`): the plugin writes it without the prefix.
    segments.length > 1 ? `${segments.slice(1).join('/')}.md` : '',
  ].filter(Boolean);
};

const redirectTwin = (args: { target: string }): string => {
  const { target } = args;
  return `# Moved\n\nThis page has moved to [${target}](${target}).\n`;
};

/**
 * Makes `<page>.md` the Markdown twin of every page that has one: copying the
 * file the llms plugin wrote elsewhere, or writing the twin of a redirect stub.
 * A page with no Markdown anywhere — an interactive React page — is left
 * without one, and is declared as such in `cloudfront/viewerRequest.js`.
 */
export const ensureMarkdownTwins = (args: {
  outDir: string;
}): { copied: number; written: number } => {
  let copied = 0;
  let written = 0;

  for (const htmlRelativePath of htmlFilesIn(args.outDir)) {
    const normalized = htmlRelativePath.split(path.sep).join('/');
    if (!normalized.endsWith('/index.html')) continue;

    const pagePath = normalized.slice(0, -'/index.html'.length);
    if (pagePath.length === 0) continue;

    const destination = path.join(args.outDir, `${pagePath}.md`);
    if (fs.existsSync(destination)) continue;

    const source = twinCandidatesOf({ pagePath })
      .map((candidate) => {
        return path.join(args.outDir, candidate);
      })
      .find((candidate) => {
        return candidate !== destination && fs.existsSync(candidate);
      });

    if (source) {
      fs.copyFileSync(source, destination);
      copied += 1;
      continue;
    }

    const target = redirectTargetOf({
      html: fs.readFileSync(path.join(args.outDir, htmlRelativePath), 'utf-8'),
    });

    if (target) {
      fs.writeFileSync(destination, redirectTwin({ target }), 'utf-8');
      written += 1;
    }
  }

  return { copied, written };
};

const linkTag = (href: string): string => {
  return `<link rel="alternate" type="text/markdown" href="${href}"/>`;
};

/** Injects the alternate link before `</head>`, at most once. */
export const injectAlternateLink = (args: {
  html: string;
  href: string;
}): string => {
  const tag = linkTag(args.href);
  if (args.html.includes(tag)) return args.html;

  const headEnd = args.html.indexOf('</head>');
  if (headEnd < 0) return args.html;

  return `${args.html.slice(0, headEnd)}${tag}${args.html.slice(headEnd)}`;
};

export const advertiseMarkdownTwins = (args: {
  outDir: string;
}): { advertised: number } => {
  let advertised = 0;

  for (const htmlRelativePath of htmlFilesIn(args.outDir)) {
    const twin = markdownTwinOf({ htmlRelativePath });
    if (!twin) continue;
    if (!fs.existsSync(path.join(args.outDir, twin.markdownRelativePath))) {
      continue;
    }

    const absolute = path.join(args.outDir, htmlRelativePath);
    const html = fs.readFileSync(absolute, 'utf-8');
    const next = injectAlternateLink({ html, href: twin.href });
    if (next === html) continue;

    fs.writeFileSync(absolute, next, 'utf-8');
    advertised += 1;
  }

  return { advertised };
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const outDir = path.resolve(__dirname, '..', process.argv[2] ?? 'build');

if (!fs.existsSync(outDir)) {
  throw new Error(
    `Build directory not found: ${outDir}. Run "docusaurus build" first.`
  );
}

const { copied, written } = ensureMarkdownTwins({ outDir });

const { advertised } = advertiseMarkdownTwins({ outDir });

process.stdout.write(
  `[markdown-twins] normalized ${copied} twins, wrote ${written} redirect twins, advertised ${advertised} Markdown alternates\n`
);
