/**
 * The machine-readable surfaces this site publishes for AI agents and
 * crawlers, declared once and reused by every place that has to name them:
 * the homepage "Built for agents" section, the 404 recovery body, and the
 * generated `static/404.md`.
 *
 * Adding a surface here is enough to advertise it everywhere; the files
 * themselves are produced by `scripts/generateAgentSurfaces.ts` (bundles) or
 * by Docusaurus plugins (`llms.txt`, `sitemap.xml`).
 */

export type AgentResource = {
  /** Site-absolute URL of the resource. */
  href: string;
  /** Short human title. */
  title: string;
  /** What an agent gets out of fetching it. */
  description: string;
  /** Content type served for the resource. */
  mediaType: string;
};

export const AGENT_RESOURCES: AgentResource[] = [
  {
    href: '/agents.md',
    title: 'agents.md',
    description:
      'Instructions for an agent: which jobs SOAT is the right tool for, which it is not, how to authenticate and call it, and how to get access.',
    mediaType: 'text/markdown',
  },
  {
    href: '/llms.txt',
    title: 'llms.txt',
    description:
      'Index of every documentation page, with a one-line summary and a link to each Markdown twin.',
    mediaType: 'text/plain',
  },
  {
    href: '/llms-full.txt',
    title: 'llms-full.txt',
    description:
      'The whole prose documentation corpus in one file, ready to be chunked and embedded.',
    mediaType: 'text/plain',
  },
  {
    href: '/openapi.json',
    title: 'openapi.json',
    description:
      'Every REST operation of the SOAT API in a single OpenAPI 3.0 description — paths, schemas, and security schemes.',
    mediaType: 'application/json',
  },
  {
    href: '/openapi.yaml',
    title: 'openapi.yaml',
    description:
      'The same merged OpenAPI description in YAML, also served at /api/openapi.yaml.',
    mediaType: 'application/yaml',
  },
  {
    href: '/errors.json',
    title: 'errors.json',
    description:
      'Catalog of every error code the API can return, with its HTTP status and what to do about it.',
    mediaType: 'application/json',
  },
  {
    href: '/docs/openapi-specs',
    title: 'Per-module OpenAPI specs',
    description:
      'One YAML spec per module under /openapi/<module>.yaml, for tools that prefer a narrower surface.',
    mediaType: 'text/html',
  },
  {
    href: '/sitemap.xml',
    title: 'sitemap.xml',
    description:
      'Every canonical page with its last-modified date, so a crawler can fetch only what changed.',
    mediaType: 'application/xml',
  },
  {
    href: '/robots.txt',
    title: 'robots.txt',
    description: 'Crawl policy: everything is allowed, plus the sitemap link.',
    mediaType: 'text/plain',
  },
];

export type RecoveryTarget = {
  href: string;
  label: string;
  hint: string;
};

/** Where the Markdown 404 body is published as a file of its own. */
export const NOT_FOUND_MARKDOWN_HREF = '/404.md';

/**
 * Entries an agent that hit a dead URL should try next. Kept separate from
 * `AGENT_RESOURCES` so the recovery map stays short: a map, not a mirror of
 * the site.
 */
export const RECOVERY_TARGETS: RecoveryTarget[] = [
  {
    href: '/docs/introduction',
    label: 'Documentation index',
    hint: 'start here for concepts and modules',
  },
  {
    href: '/agents.md',
    label: 'agents.md',
    hint: 'when to use SOAT, and how to call it',
  },
  {
    href: '/llms.txt',
    label: 'llms.txt',
    hint: 'every page, one line each',
  },
  {
    href: '/sitemap.xml',
    label: 'sitemap.xml',
    hint: 'every canonical URL',
  },
  {
    href: '/openapi.json',
    label: 'openapi.json',
    hint: 'the REST API surface',
  },
  {
    href: '/errors.json',
    label: 'errors.json',
    hint: 'error codes and their meaning',
  },
];

/**
 * The pathname to report as missing, or `undefined` when the router only knows
 * the prerendered 404 route itself (the static build has no request URL; the
 * browser supplies the real one on hydration).
 */
export const resolveMissingPathname = (args: {
  pathname?: string;
}): string | undefined => {
  if (!args.pathname) return undefined;
  return ['/404', '/404.html', '/404/'].includes(args.pathname)
    ? undefined
    : args.pathname;
};

/**
 * The Markdown body served with the 404 response. Short by design: an agent
 * needs the fact that the URL is dead and the handful of URLs that are not.
 */
export const buildNotFoundMarkdown = (args: { pathname?: string }): string => {
  const target = args.pathname ? `\`${args.pathname}\`` : 'That URL';

  const links = RECOVERY_TARGETS.map((entry) => {
    return `- [${entry.label}](${entry.href}) — ${entry.hint}`;
  }).join('\n');

  return `# 404 — Not Found

${target} does not exist on soat.ttoss.dev. This is a real HTTP 404: no page was
served, and no other path should be inferred from it.

## Where to look next

${links}

## Notes

- Every documentation page has a Markdown twin: append \`.md\` to its URL
  (\`/docs/introduction.md\`).
- The docs site is static. The SOAT REST API described in \`openapi.json\` runs
  on your own deployment, not on this domain.
`;
};
