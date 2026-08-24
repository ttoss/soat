import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DISCOVERY_PATHS,
  hasHeadingInMain,
  mainTextLength,
  MIN_TRUST_PAGE_TEXT,
  openGraphTypeProblems,
  publishedPathProblems,
  REQUIRED_SURFACES,
  TRUST_PAGES,
  trustPageProblems,
} from './checkAgentSurfaces';
import { markdownPageNames, twinFileName } from './generatePageTwins';

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
    'about.md',
    'agents.md',
    'api/openapi.yaml',
    'contact.md',
    'developers.md',
    'errors.json',
    'llms-full.txt',
    'llms.txt',
    'openapi.json',
    'openapi.yaml',
    'privacy.md',
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

test('the homepage must declare an og:type', () => {
  // Three of the four entity-resolution signals were already emitted; og:type
  // was the one Docusaurus does not add, so it went missing silently (#1113).
  assert.deepEqual(
    openGraphTypeProblems(
      '<head><meta property="og:type" content="website"/></head>'
    ),
    []
  );
  assert.deepEqual(
    openGraphTypeProblems(
      '<head><meta property=og:type content=website /></head>'
    ),
    []
  );
  assert.deepEqual(openGraphTypeProblems('<head><title>t</title></head>'), [
    'the homepage declares no og:type',
  ]);
  // Nothing to check when the file is absent; the missing-surface check owns that.
  assert.deepEqual(openGraphTypeProblems(null), []);
});

test('each trust anchor page must serve real prose, not a stub', () => {
  const long = 'word '.repeat(MIN_TRUST_PAGE_TEXT);

  assert.deepEqual(
    trustPageProblems({
      page: 'about',
      raw: page(`<h1>About</h1><p>${long}</p>`),
    }),
    []
  );

  assert.deepEqual(trustPageProblems({ page: 'about', raw: null }), [
    'missing /about — the page an agent checks to verify the project is real',
  ]);

  const thin = trustPageProblems({
    page: 'privacy',
    raw: page('<h1>Privacy</h1><p>Soon.</p>'),
  });
  assert.equal(thin.length, 1);
  assert.match(String(thin[0]), /\/privacy serves \d+ characters/);
});

test('the trust anchor pages are the three an audit looks for', () => {
  assert.deepEqual([...TRUST_PAGES], ['about', 'contact', 'privacy']);
});

test('the Markdown twin of every standalone page is a required surface', () => {
  // Derived from the pages themselves rather than restated: adding a Markdown
  // page to src/pages fails here until its twin is enforced, which is the only
  // thing standing between a new page and a 404 on its own `.md` URL.
  const required: readonly string[] = REQUIRED_SURFACES;

  for (const pageName of markdownPageNames()) {
    assert.ok(
      required.includes(twinFileName({ pageName })),
      `${twinFileName({ pageName })} is not enforced as a required surface`
    );
  }
});
