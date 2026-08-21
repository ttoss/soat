/**
 * Fails the build when the agent-facing surfaces regress.
 *
 * Each check below stands for one property an AI crawler or agent depends on,
 * and each one has been broken here before: an entry point that stopped being
 * generated, a homepage whose only heading sat outside the main content region,
 * a 404 page with nothing to recover from. Prose cannot hold these; a build
 * step can.
 *
 * Run with: pnpm tsx scripts/checkAgentSurfaces.ts [buildDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

/** Machine-readable files that must exist in the build output. */
export const REQUIRED_SURFACES = [
  'openapi.json',
  'openapi.yaml',
  'api/openapi.yaml',
  'errors.json',
  'llms.txt',
  'llms-full.txt',
  'sitemap.xml',
  'robots.txt',
  '404.md',
] as const;

/** Minimum characters of prose the homepage must serve without JavaScript. */
export const MIN_HOMEPAGE_TEXT = 500;

const mainOf = (html: string): string | null => {
  const match = /<main[^>]*>([\s\S]*)<\/main>/.exec(html);
  return match ? match[1] : null;
};

const stripped = (fragment: string): string => {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Whether the page's `<main>` region carries the `<h1>`. Extraction-based
 * crawlers read the main content region, so a heading outside it reads as a
 * page with no heading at all.
 */
export const hasHeadingInMain = (args: { html: string }): boolean => {
  const main = mainOf(args.html);
  return main === null ? false : /<h1[\s>]/.test(main);
};

/** Characters of rendered prose inside `<main>`, markup excluded. */
export const mainTextLength = (args: { html: string }): number => {
  const main = mainOf(args.html);
  return main === null ? 0 : stripped(main).length;
};

const readIfExists = (file: string): string | null => {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
};

const jsonMember = (raw: string, member: string): unknown => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return member in parsed
    ? (parsed as Record<string, unknown>)[member]
    : undefined;
};

const missingSurfaces = (outDir: string): string[] => {
  return REQUIRED_SURFACES.filter((surface) => {
    return !fs.existsSync(path.join(outDir, surface));
  }).map((surface) => {
    return `missing machine-readable surface: /${surface}`;
  });
};

const bundleProblems = (raw: string | null): string[] => {
  if (!raw) return [];
  const paths = jsonMember(raw, 'paths');
  const declared =
    typeof paths === 'object' && paths !== null ? Object.keys(paths).length : 0;
  return declared > 0 ? [] : ['/openapi.json declares no paths'];
};

const catalogProblems = (raw: string | null): string[] => {
  if (!raw) return [];
  const codes = jsonMember(raw, 'codes');
  return Array.isArray(codes) && codes.length > 0
    ? []
    : ['/errors.json lists no error codes'];
};

const homepageProblems = (raw: string | null): string[] => {
  if (!raw) return ['missing index.html'];

  const problems: string[] = [];

  if (!hasHeadingInMain({ html: raw })) {
    problems.push('the homepage has no <h1> inside <main>');
  }

  const length = mainTextLength({ html: raw });
  if (length < MIN_HOMEPAGE_TEXT) {
    problems.push(
      `the homepage serves ${length} characters of prose without JavaScript, below the ${MIN_HOMEPAGE_TEXT} minimum`
    );
  }

  return problems;
};

const notFoundProblems = (raw: string | null): string[] => {
  if (!raw) return ['missing 404.html'];
  return raw.includes('# 404')
    ? []
    : ['the 404 page carries no Markdown recovery body'];
};

const alternateProblems = (raw: string | null): string[] => {
  if (!raw) return [];
  return raw.includes('type="text/markdown" href="/docs/introduction.md"')
    ? []
    : [
        'documentation pages do not advertise their Markdown twin (run advertise-markdown-twins)',
      ];
};

export const checkBuild = (args: { outDir: string }): string[] => {
  const at = (relativePath: string) => {
    return readIfExists(path.join(args.outDir, relativePath));
  };

  return [
    ...missingSurfaces(args.outDir),
    ...bundleProblems(at('openapi.json')),
    ...catalogProblems(at('errors.json')),
    ...homepageProblems(at('index.html')),
    ...notFoundProblems(at('404.html')),
    ...alternateProblems(at('docs/introduction/index.html')),
  ];
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const outDir = path.resolve(__dirname, '..', process.argv[2] ?? 'build');

if (!fs.existsSync(outDir)) {
  throw new Error(
    `Build directory not found: ${outDir}. Run "docusaurus build" first.`
  );
}

const problems = checkBuild({ outDir });

if (problems.length > 0) {
  throw new Error(
    `The build is missing agent-facing surfaces:\n  - ${problems.join('\n  - ')}`
  );
}

process.stdout.write(
  `[agent-surfaces] ${REQUIRED_SURFACES.length} surfaces present, homepage and 404 checks passed\n`
);
