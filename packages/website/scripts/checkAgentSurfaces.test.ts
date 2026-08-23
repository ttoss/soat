import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DISCOVERY_PATHS,
  hasHeadingInMain,
  mainTextLength,
  publishedPathProblems,
  REQUIRED_SURFACES,
} from './checkAgentSurfaces';

const page = (main: string, extra = '') => {
  return `<!doctype html><html><head><title>t</title></head><body><nav>Docs Tutorials</nav>${extra}<main>${main}</main><footer>©</footer></body></html>`;
};

test('the heading check only counts an h1 inside the main content region', () => {
  assert.equal(
    hasHeadingInMain({ html: page('<h1>Title</h1><p>Body</p>') }),
    true
  );
  // A hero heading parked outside <main> is what content extractors miss.
  assert.equal(
    hasHeadingInMain({
      html: page('<p>Body</p>', '<header><h1>Title</h1></header>'),
    }),
    false
  );
  assert.equal(
    hasHeadingInMain({ html: '<html><body><h1>x</h1></body></html>' }),
    false
  );
});

test('text length counts prose, not markup, scripts or styles', () => {
  const html = page(
    '<h1>Title</h1><script>const noise = "aaaaaaaaaaaaaaaaaaaa";</script><style>.a{color:red}</style><p>Hello&nbsp;world</p>'
  );

  assert.equal(mainTextLength({ html }), 'Title Hello world'.length);
});

test('the required surfaces include every machine-readable entry point', () => {
  assert.deepEqual([...REQUIRED_SURFACES].sort(), [
    '404.md',
    'agents.md',
    'api/openapi.yaml',
    'errors.json',
    'llms-full.txt',
    'llms.txt',
    'openapi.json',
    'openapi.yaml',
    'robots.txt',
    'sitemap.xml',
  ]);
});

test('the published bundle must declare the standard discovery endpoints', () => {
  const bundle = (paths: string[]) => {
    return JSON.stringify({
      paths: Object.fromEntries(
        paths.map((p) => {
          return [p, { get: {} }];
        })
      ),
    });
  };

  assert.deepEqual(publishedPathProblems(bundle([...DISCOVERY_PATHS])), []);

  // An audit that cannot probe a live host reads the description instead; a
  // bundle that omits the OAuth metadata endpoints reports "OAuth mentioned but
  // no standard endpoints found", which is what #1099 recorded.
  assert.deepEqual(publishedPathProblems(bundle(['/api/v1/projects'])), [
    '/openapi.json does not declare /.well-known/oauth-authorization-server',
    '/openapi.json does not declare /.well-known/oauth-protected-resource',
  ]);

  // Nothing to check when the file was not built; `missingSurfaces` reports that.
  assert.deepEqual(publishedPathProblems(null), []);
});
