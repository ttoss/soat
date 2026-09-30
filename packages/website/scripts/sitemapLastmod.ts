import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Docusaurus dates a doc's `<lastmod>` from the git history of its source
 * file, so a page generated at build time (the API, SDK, MCP, CLI and
 * formations references, the permissions and error-code pages) and every
 * `src/pages` page go out undated. Each of those is dated here from the git
 * history of the file it is generated from: an operation page moves when its
 * OpenAPI spec does, and not when an unrelated doc is edited.
 */

export const REPO_ROOT = path.resolve(__dirname, '../../..');

const SPECS = 'packages/server/src/rest/openapi/v1';

const spec = (slug: string): string[] => {
  const file = `${SPECS}/${slug}.yaml`;
  return fs.existsSync(path.join(REPO_ROOT, file)) ? [file] : [];
};

/** Pages generated from one module's spec, by the path segment naming it. */
const SPEC_FAMILIES = [
  /^\/docs\/api\/([^/]+)/,
  /^\/docs\/sdk\/services\/([^/]+)/,
  /^\/docs\/mcp\/tools\/([^/]+)/,
  /^\/docs\/cli\/commands\/([^/]+)/,
];

/** Pages generated from, or written as, one fixed set of sources. */
const FIXED_SOURCES: Record<string, string[]> = {
  '/': [
    'packages/website/src/pages/index.tsx',
    'packages/website/src/components',
    'packages/website/src/data/homepage.ts',
  ],
  '/benchmark': [
    'packages/website/src/pages/benchmark.tsx',
    'packages/website/src/data/solutions',
  ],
  '/about': ['packages/website/src/pages/about.md'],
  '/contact': ['packages/website/src/pages/contact.md'],
  '/privacy': ['packages/website/src/pages/privacy.md'],
  '/docs/api': [SPECS],
  '/docs/openapi-specs': [SPECS],
  '/docs/sdk/services': [SPECS],
  '/docs/mcp/tools': [SPECS],
  '/docs/cli/commands': [SPECS],
  '/docs/permissions': ['packages/server/src/permissions'],
  '/docs/error-codes': ['packages/server/src/errors/codes.ts'],
  '/docs/webhook-events': ['packages/server/src/lib/soatEvents.ts'],
};

/** The repository paths a page is built from, or none when git dates it. */
export const sourcesForPath = (args: { pathname: string }): string[] => {
  const pathname = args.pathname.replace(/\/$/, '') || '/';
  if (FIXED_SOURCES[pathname]) return FIXED_SOURCES[pathname];
  if (pathname.startsWith('/docs/formations-types')) return spec('formations');
  for (const family of SPEC_FAMILIES) {
    const match = family.exec(pathname);
    if (match) return spec(match[1]);
  }
  return [];
};

export type DatedItem = { url: string; lastmod?: string | null };

/** Each undated item dated from its sources; dated or unmapped ones as they are. */
export const withLastmod = <T extends DatedItem>(args: {
  items: T[];
  lastmodOf: (sources: string[]) => string | undefined;
}): T[] => {
  return args.items.map((item) => {
    if (item.lastmod) return item;
    const sources = sourcesForPath({ pathname: new URL(item.url).pathname });
    const lastmod = sources.length > 0 ? args.lastmodOf(sources) : undefined;
    return lastmod ? { ...item, lastmod } : item;
  });
};

/** The committer date of the last commit touching `sources`, cached. */
export const gitLastmod = (): ((sources: string[]) => string | undefined) => {
  const cache = new Map<string, string | undefined>();
  return (sources) => {
    const key = sources.join('\n');
    if (!cache.has(key)) {
      let date: string | undefined;
      try {
        date =
          execFileSync('git', ['log', '-1', '--format=%cI', '--', ...sources], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          }).trim() || undefined;
      } catch {
        date = undefined;
      }
      cache.set(key, date && new Date(date).toISOString());
    }
    return cache.get(key);
  };
};
