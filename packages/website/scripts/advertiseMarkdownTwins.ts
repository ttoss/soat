/**
 * Advertises the Markdown twin of every page in the page itself.
 *
 * `docusaurus-plugin-llms` already emits `<page>.md` next to each generated
 * page, but nothing in the HTML says so, which leaves an agent guessing. This
 * plugin adds the RFC 8288 link relation that names it:
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
 * Note this is discovery, not negotiation, and the difference is not a choice
 * made here. acceptmarkdown.com asks for four things on the *same* URL —
 * Markdown under `Accept: text/markdown`, `Vary: Accept` on the response, `406`
 * for an unsupported type, and q-value ordering — and every one of them is
 * request-time logic. An S3 origin cannot run any of it, and the distribution
 * in front of it is not ours to change: `carlin deploy static-app` builds the
 * whole `AWS::CloudFront::Distribution` from a fixed template (cache policy,
 * response-headers policy, and a single `AppendIndexDotHtml` viewer function
 * included), and exposes no hook for another function association or for a
 * policy that adds `Accept` to `Vary` — which is why the site answers
 * `Vary: Origin` today.
 *
 * Closing it needs one of: a `carlin` option for extra viewer-request functions
 * and a custom response-headers policy (upstream, `@ttoss`), or the same two
 * resources attached to the distribution out-of-band. The rewrite itself is
 * four lines — map an `Accept` that prefers `text/markdown` onto the `.md` twin
 * this script already advertises, since every page has one — so the work is the
 * plumbing, not the logic.
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

const htmlFilesIn = (root: string, current = root): string[] => {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) return htmlFilesIn(root, absolute);
    return entry.name.endsWith('.html') ? [path.relative(root, absolute)] : [];
  });
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

const { advertised } = advertiseMarkdownTwins({ outDir });

process.stdout.write(
  `[markdown-twins] advertised ${advertised} Markdown alternates\n`
);
