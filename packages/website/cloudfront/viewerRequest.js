/**
 * CloudFront viewer request function of the docs distribution.
 *
 * It negotiates the page representation, then appends `index.html` via the
 * `appendIndexHtml(request)` helper carlin injects into this file. Negotiation
 * runs first: appending would otherwise turn `/docs/x` into
 * `/docs/x/index.html` before there is a page path to map onto `/docs/x.md`.
 * A cache behavior takes a single viewer request function, so the
 * `appendIndexHtml` option and this file are mutually exclusive.
 *
 * The runtime is `cloudfront-js-2.0`: ES 5.1, no network, filesystem, timers or
 * dynamic evaluation, and a 10 KB limit on this file plus the injected helper.
 * `scripts/viewerRequest.test.ts` runs it against that same composition.
 */

/**
 * The two representations a page can have. HTML is the default: a tie resolves
 * to it, so a wildcard `Accept` is never answered with Markdown.
 */
var HTML_TYPE = 'text/html';
var MARKDOWN_TYPE = 'text/markdown';

/**
 * The Markdown representation of the homepage, which has no `.md` twin of its
 * own. This is what its HTML advertises as `rel="alternate"`, so negotiation
 * and discovery cannot disagree.
 */
var HOME_MARKDOWN_URI = '/agents.md';

/**
 * Pages with no Markdown representation: the interactive React pages, which the
 * Markdown pipeline never sees. Every other page has a twin at `<page>.md`.
 * These are served as HTML, and refused with a `406` when the request rules
 * HTML out. `scripts/viewerRequest.test.ts` keeps the list current.
 */
var NO_MARKDOWN_URIS = ['/benchmark', '/blog'];

/**
 * Quality of one media type under an `Accept` header, by RFC 9110 §12.5.1:
 * the most specific matching range decides, and only then its `q`. A type no
 * range matches, and one matched by a range with `q=0`, are both refused.
 */
function quality(accept, type) {
  var ranges = accept.split(',');
  var bestSpecificity = -1;
  var bestQuality = 0;
  var typeGroup = type.split('/')[0] + '/*';

  for (var i = 0; i < ranges.length; i++) {
    var parts = ranges[i].split(';');
    var range = parts[0].trim().toLowerCase();

    var specificity = -1;
    if (range === type) {
      specificity = 2;
    } else if (range === typeGroup) {
      specificity = 1;
    } else if (range === '*/*') {
      specificity = 0;
    }

    if (specificity <= bestSpecificity) {
      continue;
    }

    var rangeQuality = 1;
    for (var j = 1; j < parts.length; j++) {
      var parameter = parts[j].trim().toLowerCase();
      if (parameter.indexOf('q=') === 0) {
        var parsed = parseFloat(parameter.slice(2));
        rangeQuality = isNaN(parsed) ? 0 : parsed;
      }
    }

    bestSpecificity = specificity;
    bestQuality = rangeQuality;
  }

  return bestQuality;
}

/**
 * Whether the URI addresses a page, which is what has two representations. A
 * file — an asset, `/openapi.json`, a `.md` twin asked for by name — passes
 * through untouched and is never refused with a `406`.
 */
function isPage(uri) {
  var lastSlash = uri.lastIndexOf('/');
  return uri.slice(lastSlash + 1).indexOf('.') === -1;
}

/**
 * The page a URI addresses, so `/docs/x` and `/docs/x/` — the same resource —
 * are negotiated the same way.
 */
function pagePath(uri) {
  return uri.length > 1 && uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

/** Whether a page has a Markdown representation to negotiate for. */
function hasMarkdown(path) {
  return NO_MARKDOWN_URIS.indexOf(path) === -1;
}

/** The Markdown twin of a page, as built next to its `index.html`. */
function markdownUri(path) {
  return path === '/' ? HOME_MARKDOWN_URI : path + '.md';
}

/** Names the representations this page has, so the client can retry. */
function notAcceptable(markdown) {
  return {
    statusCode: 406,
    statusDescription: 'Not Acceptable',
    headers: {
      'content-type': { value: 'text/plain' },
    },
    body:
      'This URL is available as ' +
      (markdown ? HTML_TYPE + ' and as ' + MARKDOWN_TYPE : HTML_TYPE) +
      '. Send an Accept header that includes one of them.\n',
  };
}

function handler(event) {
  var request = event.request;

  if (!isPage(request.uri)) {
    return appendIndexHtml(request);
  }

  /**
   * A request with no `Accept` header accepts anything, which is the full
   * wildcard range and therefore resolves to HTML.
   */
  var accept = request.headers.accept ? request.headers.accept.value : '*/*';

  var path = pagePath(request.uri);
  var markdown = hasMarkdown(path);

  var markdownQuality = markdown ? quality(accept, MARKDOWN_TYPE) : 0;
  var htmlQuality = quality(accept, HTML_TYPE);

  if (markdownQuality === 0 && htmlQuality === 0) {
    return notAcceptable(markdown);
  }

  if (markdownQuality > htmlQuality) {
    request.uri = markdownUri(path);
    return request;
  }

  return appendIndexHtml(request);
}
