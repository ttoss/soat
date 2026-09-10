import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDeclaredQueryParams } from 'src/lib/openapiSpec';

/**
 * Every query parameter a route handler reads must be declared by one of the
 * spec operations its file registers.
 *
 * `strictFieldsMiddleware` rejects an undeclared parameter with `400` on every
 * documented route, so an omission here is not a documentation gap — it makes
 * the parameter unusable in production while the handler still reads it, and
 * only an end-to-end test that happens to pass that parameter would notice.
 *
 * Attribution is per file rather than per route: a handler may read the query
 * through a helper declared beside it (`hasValidDownloadToken`), so a
 * source-position rule would be a rule about where a function sits in a file.
 */
const ROUTES_DIR = path.resolve(__dirname, '../../../../src/rest/v1');

const routeRegistrations = (source: string): Array<[string, string]> => {
  const pattern = /[\w.]*[Rr]outer\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  return [...source.matchAll(pattern)].map((match) => {
    return [match[1], match[2]];
  });
};

// `ctx.query.name`, `ctx.query['name']`, and the `const { a, b } = ctx.query`
// destructuring the listing routes use.
const readQueryNames = (source: string): Set<string> => {
  const names = new Set<string>();
  for (const match of source.matchAll(/ctx\.query\.([A-Za-z_]\w*)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/ctx\.query\['([^']+)'\]/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(
    /const\s*\{([^}]*)\}\s*=\s*ctx\.query/gs
  )) {
    for (const part of match[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (name) names.add(name);
    }
  }
  // Read through helpers that take the name as an argument rather than
  // touching `ctx.query` at the call site.
  for (const match of source.matchAll(
    /parseEnumListQuery\(\{[^}]*name:\s*'([^']+)'/gs
  )) {
    names.add(match[1]);
  }
  if (source.includes('parsePagination(ctx)')) {
    names.add('limit');
    names.add('offset');
  }
  return names;
};

const toTemplate = (routePath: string): string => {
  const withBraces = routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return withBraces.startsWith('/api/v1') ? withBraces : `/api/v1${withBraces}`;
};

// Every name any operation registered in the file declares.
const declaredInFile = (source: string): Set<string> => {
  const declared = new Set<string>();
  for (const [method, routePath] of routeRegistrations(source)) {
    const names = getDeclaredQueryParams({
      method,
      path: toTemplate(routePath),
    });
    for (const name of names ?? []) declared.add(name);
  }
  return declared;
};

describe('query parameter contract', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((file) => {
    return file.endsWith('.ts');
  });

  test.each(files)('%s declares every parameter it reads', (file) => {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
    if (routeRegistrations(source).length === 0) return;

    const declared = declaredInFile(source);
    const undeclared = [...readQueryNames(source)].filter((name) => {
      return !declared.has(name);
    });

    expect(undeclared).toEqual([]);
  });
});
