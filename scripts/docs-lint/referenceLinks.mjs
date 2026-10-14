import { readFileSync } from 'node:fs';

import { ROOT } from './common.mjs';

// ── Check 6: an endpoint mention must link to its reference page ─────────────
//
// Every resolvable mention, not just the first on a page: reference docs are
// entered by deep link, so a reader landing mid-page never sees the top. It is
// also the only version of the rule a script can check.
//
// The address is derived rather than stored, since `docs/api/` is gitignored and
// the slug exists only after a generator runs. `pr.yml` skips the website build
// for Markdown-only PRs — precisely the PR that adds these links — so a typo
// would otherwise surface at the next release deploy.
//
// A mention resolving to no operation is left alone: provider-side routes, and
// phrases naming a class rather than a route.

/**
 * The slug `docusaurus-plugin-openapi-docs` derives from an `operationId`,
 * which is lodash `kebabCase` — note it splits a digit run into its own word
 * (`downloadFileBase64` -> `download-file-base-64`), which a plain
 * camel-boundary split gets wrong.
 */
export const operationSlug = (operationId) => {
  return (
    operationId.match(
      /[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|\b)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g
    ) ?? []
  )
    .map((word) => {
      return word.toLowerCase();
    })
    .join('-');
};

/**
 * Every `` `METHOD /path` `` token in a page, with whether it is already inside
 * a Markdown link. Fenced blocks are skipped: their content is copy-pasted
 * verbatim, so a link cannot be added there.
 */
export const scanReferenceMentions = (text) => {
  const mentions = [];
  let fenced = false;

  for (const [i, line] of text.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const m of line.matchAll(
      /`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s]*)`/g
    )) {
      const before = line[m.index - 1];
      const after = line.slice(m.index + m[0].length);
      mentions.push({
        line: i + 1,
        token: m[0],
        method: m[1].toLowerCase(),
        // A query string is not part of the route: `GET /usage/meters?source=eval`
        // is `listUsageMeters`. A trailing `/` is not either.
        path: m[2].split(/[?#]/)[0].replace(/\/$/, ''),
        linked: before === '[' && /^\]\(/.test(after),
      });
    }
  }

  return mentions;
};

/** The route a mention names, or null when it names none. */
const resolveMention = (routeIndex, mention) => {
  // A wildcard or elision is a class of routes, not one operation.
  if (/[*…]/.test(mention.path)) return null;

  // Docs write the path both with and without the `/api/v1` prefix the specs
  // declare; `:id` and `{document_id}` both match the index's `[^/]+` segments.
  const candidates = mention.path.startsWith('/api/v1/')
    ? [mention.path]
    : [`/api/v1${mention.path}`, mention.path];

  for (const path of candidates) {
    const route = routeIndex.find((r) => {
      return r.method === mention.method && r.re.test(path);
    });
    if (route) return route;
  }
  return null;
};

export const referencePath = (route) => {
  return `/docs/api/${route.module}/${operationSlug(route.operationId)}`;
};

export const checkReferenceLinks = (files, routeIndex) => {
  const found = [];
  const known = new Set(
    routeIndex.map((route) => {
      return referencePath(route);
    })
  );

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const text = readFileSync(file, 'utf-8');

    for (const mention of scanReferenceMentions(text)) {
      if (mention.linked) continue;
      const route = resolveMention(routeIndex, mention);
      if (!route) continue;
      found.push(
        `${rel}:${mention.line}  [unlinked API reference]  ${mention.token} -> ${referencePath(route)}`
      );
    }

    // The other direction: a link addressing a page no operation generates.
    for (const [i, line] of text.split('\n').entries()) {
      for (const link of line.matchAll(/\]\((\/docs\/api\/[^)#\s]+)\)/g)) {
        if (known.has(link[1])) continue;
        found.push(`${rel}:${i + 1}  [unknown API reference link]  ${link[1]}`);
      }
    }
  }

  return found;
};
