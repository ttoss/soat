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
 * Note this is discovery, not negotiation: serving Markdown from the *same*
 * URL under `Accept: text/markdown` (with `Vary: Accept`) needs logic at the
 * edge, which the static S3 + CloudFront origin cannot run today.
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
 * page directory (`index.html` at the root, `404.html`, …) and therefore has
 * no `<page>.md` sibling.
 */
export const markdownTwinOf = (args: {
  htmlRelativePath: string;
}): MarkdownTwin | null => {
  const normalized = args.htmlRelativePath.split(path.sep).join('/');

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
