import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasHeadingInMain,
  mainTextLength,
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
