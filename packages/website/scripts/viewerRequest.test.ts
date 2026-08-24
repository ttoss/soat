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
 * The helper carlin injects into the function (`appendIndexHtml` in
 * `packages/carlin/src/deploy/staticApp/viewerRequestFunction.ts`), transcribed
 * so the tests exercise the same composition CloudFront runs. A cache behavior
 * takes a single viewer request function, so this logic — the `appendIndexHtml`
 * option carlin used to associate — is called from ours instead.
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

  // The same page reached with a trailing slash is the same resource, so it
  // resolves to the same twin rather than to `/docs/introduction/.md`.
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
  // The homepage has no `.md` twin of its own — it is not a doc page — and
  // already advertises `/agents.md` as its `rel="alternate"` (see
  // `src/pages/index.tsx`). Negotiation resolves to what the HTML advertises.
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
  // No `Accept` at all, and the `*/*` every CLI client sends, both match HTML
  // and Markdown equally. HTML is the default representation, so a tie is not
  // a reason to hand a browser a Markdown file.
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

  // `q=0` is a refusal, so HTML wins through the wildcard even though the
  // Markdown media type is named explicitly.
  assert.equal(
    run({
      uri: '/docs/introduction',
      accept: 'text/markdown;q=0, */*;q=0.5',
    }).uri,
    '/docs/introduction/index.html'
  );
});

test('a more specific media range outranks a wildcard regardless of its q', () => {
  // RFC 9110 §12.5.1: precedence is by specificity, not by q. `text/html;q=0.1`
  // is the quality of HTML even though `text/*;q=0.9` also matches it, so
  // Markdown — which only matches the wildcard — wins at 0.9.
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
  // The body names both representations, so a client that got here can retry
  // without reading the docs.
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
  // `/benchmark` is a React page, not a doc page, so no `.md` is built for it.
  // Rewriting to a twin that does not exist would answer with a 404 for a page
  // that is right there in HTML.
  assert.equal(
    run({
      uri: '/benchmark',
      accept: 'text/markdown, text/html;q=0.5',
    }).uri,
    '/benchmark/index.html'
  );

  // It is HTML-only, not exempt from negotiation: a client that asked for
  // Markdown and nothing else is told so, rather than handed HTML it said it
  // would not take.
  const refused = run({ uri: '/benchmark', accept: 'text/markdown' });

  assert.equal(refused.statusCode, 406);
  // And told what it can have: naming a Markdown variant this page never had
  // would send the client back for a 404.
  assert.match(String(refused.body), /text\/html/);
  assert.doesNotMatch(String(refused.body), /text\/markdown/);
});

test('every page outside the docs tree either has a twin or is declared HTML-only', () => {
  // The function cannot test whether a `.md` twin exists, so the pages that
  // have none are named in it. This is the check that keeps that list current:
  // a new React page under `src/pages` is negotiable the moment it ships,
  // which — with no twin built for it — means a 404 on the Markdown variant.
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
  // Only pages have two representations. An asset request is passed through
  // untouched — including one whose `Accept` names neither page type, which
  // must not turn into a 406.
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

  // A URL that already names the Markdown twin is served as asked, not
  // rewritten to `/docs/introduction.md.md`.
  assert.equal(
    run({ uri: '/docs/introduction.md', accept: 'text/markdown' }).uri,
    '/docs/introduction.md'
  );
});

test('the function fits what CloudFront accepts', () => {
  // carlin injects `appendIndexHtml` into the same file, and the helper counts
  // against this budget, so the margin measured here is optimistic by its size.
  assert.ok(
    Buffer.byteLength(source, 'utf-8') < MAX_FUNCTION_SIZE_BYTES,
    'the viewer request function must stay under 10 KB'
  );

  // Two `handler` declarations would silently drop one behavior: the composed
  // source carlin builds keeps a single entry point, which is ours.
  assert.equal(source.match(/function\s+handler\s*\(/g)?.length, 1);
  assert.match(source, /appendIndexHtml\(/);
});

test('the deploy config associates the function and varies on Accept', () => {
  const config = load(fs.readFileSync(CARLIN_YML_PATH, 'utf-8')) as {
    appendIndexHtml?: boolean;
    environments: {
      Production: {
        cloudfront?: boolean;
        responseHeaders?: {
          header: string;
          value: string;
          override: boolean;
        }[];
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

  // `appendIndexHtml` and a function of our own are mutually exclusive in
  // carlin — a cache behavior takes one viewer request function — and ours
  // calls the injected helper instead.
  assert.equal(config.appendIndexHtml, undefined);

  // Serving two representations of one URL without telling caches which header
  // decides is what breaks them, so the header ships with the function or not
  // at all.
  //
  // Asserted as the *array* form, which is the whole point: carlin applies
  // environment overrides after yargs `coerce`, so the object form arrives at
  // the template unparsed, fails its `responseHeaders.length > 0` check, and
  // leaves the managed policy attached with no error anywhere. v0.29.2 shipped
  // exactly that and answered `vary: Origin` (#1111). An assertion that only
  // reads the value back — `responseHeaders.vary === 'Accept'` — passes in both
  // cases and is why this went out; this one pins the shape carlin consumes.
  assert.ok(
    Array.isArray(production.responseHeaders),
    'responseHeaders must use the array form: the object form is silently dropped from an environment block'
  );

  assert.deepEqual(production.responseHeaders, [
    { header: 'vary', value: 'Accept', override: true },
  ]);
});

test('every page the function rewrites has the file it rewrites to', () => {
  // The edge cannot test whether a file exists, so this is where that is
  // checked: the built output is walked and every page is negotiated for
  // Markdown, which must land on a file that was actually emitted. It is the
  // check that catches a new page tree whose twins the build does not produce,
  // and the counterpart of `advertiseMarkdownTwins` — a page is advertised and
  // negotiable, or neither.
  //
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

  // A tree this size means the walk found the real output, not an empty dir.
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
