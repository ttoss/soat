import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as url from 'node:url';

import { load } from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const FUNCTION_PATH = path.resolve(
  __dirname,
  '..',
  'cloudfront',
  'viewerRequest.js'
);

const CARLIN_YML_PATH = path.resolve(__dirname, '..', 'carlin.yml');

/**
 * Maximum size of a CloudFront Function, in bytes. carlin rejects a composed
 * source above it at synth time, so it is checked here instead of at deploy.
 *
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-function-quotas.html
 */
const MAX_FUNCTION_SIZE_BYTES = 10 * 1024;

const source = fs.readFileSync(FUNCTION_PATH, 'utf-8');

/**
 * The helper carlin injects into the function, transcribed so the tests
 * exercise the same composition CloudFront runs.
 */
const appendIndexHtml = (request: { uri: string }) => {
  const uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }
  return request;
};

type FunctionResponse = {
  statusCode?: number;
  statusDescription?: string;
  headers?: { [header: string]: { value: string } };
  body?: string;
  uri?: string;
};

const noMarkdownUris = new Function(
  'appendIndexHtml',
  `${source}\nreturn NO_MARKDOWN_URIS;`
)(appendIndexHtml) as string[];

const handler = new Function('appendIndexHtml', `${source}\nreturn handler;`)(
  appendIndexHtml
) as (event: {
  request: {
    uri: string;
    headers: { [header: string]: { value: string } };
  };
}) => FunctionResponse;

const run = (args: { uri: string; accept?: string }): FunctionResponse => {
  return handler({
    request: {
      uri: args.uri,
      headers:
        args.accept === undefined ? {} : { accept: { value: args.accept } },
    },
  });
};

test('a Markdown request for a page is served the page Markdown twin', () => {
  assert.equal(
    run({ uri: '/docs/introduction', accept: 'text/markdown' }).uri,
    '/docs/introduction.md'
  );

  // A trailing slash addresses the same resource, so it resolves to the same twin.
  assert.equal(
    run({ uri: '/docs/introduction/', accept: 'text/markdown' }).uri,
    '/docs/introduction.md'
  );

  assert.equal(
    run({ uri: '/docs/api/agents/create-agent', accept: 'text/markdown' }).uri,
    '/docs/api/agents/create-agent.md'
  );
});

test('a Markdown request for the homepage is served the agent instructions', () => {
  // The homepage has no `.md` twin and advertises `/agents.md` as its
  // `rel="alternate"`, so negotiation resolves to the same file.
  assert.equal(run({ uri: '/', accept: 'text/markdown' }).uri, '/agents.md');
});

test('an HTML request is served the page, index appended', () => {
  const browserAccept =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

  assert.equal(
    run({ uri: '/docs/introduction', accept: browserAccept }).uri,
    '/docs/introduction/index.html'
  );
  assert.equal(run({ uri: '/', accept: browserAccept }).uri, '/index.html');
});

test('a request that states no preference is served HTML', () => {
  // A tie resolves to HTML, the default representation.
  assert.equal(
    run({ uri: '/docs/introduction' }).uri,
    '/docs/introduction/index.html'
  );
  assert.equal(
    run({ uri: '/docs/introduction', accept: '*/*' }).uri,
    '/docs/introduction/index.html'
  );
  assert.equal(
    run({ uri: '/docs/introduction', accept: 'text/*' }).uri,
    '/docs/introduction/index.html'
  );
});

test('q-values decide which representation wins', () => {
  assert.equal(
    run({
      uri: '/docs/introduction',
      accept: 'text/html;q=0.5, text/markdown;q=0.9',
    }).uri,
    '/docs/introduction.md'
  );

  assert.equal(
    run({
      uri: '/docs/introduction',
      accept: 'text/markdown;q=0.4, text/html;q=0.8',
    }).uri,
    '/docs/introduction/index.html'
  );

  // `q=0` is a refusal, so HTML wins through the wildcard.
  assert.equal(
    run({
      uri: '/docs/introduction',
      accept: 'text/markdown;q=0, */*;q=0.5',
    }).uri,
    '/docs/introduction/index.html'
  );
});

test('a more specific media range outranks a wildcard regardless of its q', () => {
  // RFC 9110 §12.5.1: precedence is by specificity, not by q.
  assert.equal(
    run({ uri: '/docs/introduction', accept: 'text/*;q=0.9, text/html;q=0.1' })
      .uri,
    '/docs/introduction.md'
  );

  assert.equal(
    run({ uri: '/docs/introduction', accept: '*/*;q=0.9, text/markdown;q=0.1' })
      .uri,
    '/docs/introduction/index.html'
  );
});

test('a page request that accepts neither representation gets a 406', () => {
  const response = run({
    uri: '/docs/introduction',
    accept: 'application/json',
  });

  assert.equal(response.statusCode, 406);
  assert.equal(response.statusDescription, 'Not Acceptable');
  assert.equal(response.headers?.['content-type']?.value, 'text/plain');
  // The body names both representations so the client can retry.
  assert.match(String(response.body), /text\/html/);
  assert.match(String(response.body), /text\/markdown/);
});

test('refusing every type with q=0 is also a 406', () => {
  assert.equal(
    run({
      uri: '/docs/introduction',
      accept: 'text/html;q=0, text/markdown;q=0',
    }).statusCode,
    406
  );
});

test('a page with no Markdown representation never rewrites to a missing twin', () => {
  // `/benchmark` is a React page with no `.md` twin, so it is never rewritten.
  assert.equal(
    run({
      uri: '/benchmark',
      accept: 'text/markdown, text/html;q=0.5',
    }).uri,
    '/benchmark/index.html'
  );

  // HTML-only, not exempt: a Markdown-only request is refused, not served HTML.
  const refused = run({ uri: '/benchmark', accept: 'text/markdown' });

  assert.equal(refused.statusCode, 406);
  // The body names only what this page has.
  assert.match(String(refused.body), /text\/html/);
  assert.doesNotMatch(String(refused.body), /text\/markdown/);
});

test('every page outside the docs tree either has a twin or is declared HTML-only', () => {
  // The function cannot test whether a twin exists, so pages without one are
  // named in it. This keeps that list current as `src/pages` grows.
  const pagesDir = path.resolve(__dirname, '..', 'src', 'pages');

  const pageUris = fs
    .readdirSync(pagesDir)
    .filter((entry) => {
      return entry.endsWith('.tsx');
    })
    .map((entry) => {
      return `/${path.basename(entry, '.tsx')}`;
    });

  for (const pageUri of pageUris) {
    // The homepage is the exception with a twin of its own choosing.
    if (pageUri === '/index') continue;

    assert.ok(
      noMarkdownUris.includes(pageUri),
      `${pageUri} is a page with no Markdown twin: add it to NO_MARKDOWN_URIS in cloudfront/viewerRequest.js, or generate a twin for it`
    );
  }
});

test('files are outside negotiation', () => {
  // Only pages have two representations; assets pass through untouched and are
  // never refused.
  assert.equal(
    run({ uri: '/openapi.json', accept: 'application/json' }).uri,
    '/openapi.json'
  );
  assert.equal(
    run({ uri: '/assets/js/main.1a2b3c.js', accept: '*/*' }).uri,
    '/assets/js/main.1a2b3c.js'
  );
  assert.equal(
    run({ uri: '/img/soat-architecture.png', accept: 'image/webp,*/*;q=0.8' })
      .uri,
    '/img/soat-architecture.png'
  );

  // A URL naming the twin is served as asked, not rewritten twice.
  assert.equal(
    run({ uri: '/docs/introduction.md', accept: 'text/markdown' }).uri,
    '/docs/introduction.md'
  );
});

test('the function fits what CloudFront accepts', () => {
  // The injected helper counts against this budget too.
  assert.ok(
    Buffer.byteLength(source, 'utf-8') < MAX_FUNCTION_SIZE_BYTES,
    'the viewer request function must stay under 10 KB'
  );

  // Two `handler` declarations would silently drop one behavior.
  assert.equal(source.match(/function\s+handler\s*\(/g)?.length, 1);
  assert.match(source, /appendIndexHtml\(/);
});

test('the deploy config associates the function and does not set responseHeaders', () => {
  const config = load(fs.readFileSync(CARLIN_YML_PATH, 'utf-8')) as {
    appendIndexHtml?: boolean;
    environments: {
      Production: {
        cloudfront?: boolean;
        responseHeaders?: unknown;
        viewerRequestFunctionCode?: string;
      };
    };
  };

  const production = config.environments.Production;

  assert.equal(production.cloudfront, true);
  assert.equal(
    production.viewerRequestFunctionCode,
    './cloudfront/viewerRequest.js'
  );

  // `appendIndexHtml` and a function of our own are mutually exclusive: a cache
  // behavior takes one viewer request function.
  assert.equal(config.appendIndexHtml, undefined);

  // `responseHeaders` is deliberately unset: CloudFront rejects the policy
  // carlin builds for a defined `vary`, which fails the deploy (#1111).
  assert.equal(
    production.responseHeaders,
    undefined,
    'responseHeaders makes the Production deploy fail until carlin can set Vary without touching the CORS headers'
  );
});

test('every page the function rewrites has the file it rewrites to', () => {
  // The edge cannot test whether a file exists, so it is checked here: every
  // built page is negotiated for Markdown and must land on an emitted file.
  // `turbo run test` depends on `build`, so the output is there in CI.
  const outDir = path.resolve(__dirname, '..', 'build');

  const pagesIn = (current: string): string[] => {
    return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) return pagesIn(absolute);
      if (entry.name !== 'index.html') return [];
      const uri = `/${path.relative(outDir, path.dirname(absolute))}`;
      return [uri === '/.' ? '/' : uri.split(path.sep).join('/')];
    });
  };

  const pages = pagesIn(outDir);

  // Guards against walking an empty directory.
  assert.ok(
    pages.length > 100,
    `only ${pages.length} pages found in ${outDir}`
  );

  for (const uri of pages) {
    const negotiated = run({ uri, accept: 'text/markdown, text/html;q=0.5' });

    if (negotiated.statusCode === 406) {
      assert.fail(`${uri} was refused a representation it can be served`);
    }

    assert.ok(
      fs.existsSync(path.join(outDir, String(negotiated.uri))),
      `${uri} negotiated to ${negotiated.uri}, which the build does not emit`
    );
  }
});
