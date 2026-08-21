import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_RESOURCES,
  buildNotFoundMarkdown,
  NOT_FOUND_MARKDOWN_HREF,
  RECOVERY_TARGETS,
  resolveMissingPathname,
} from '../src/data/agentResources';

test('every agent resource declares a site-absolute href and a media type', () => {
  assert.ok(AGENT_RESOURCES.length > 0);

  for (const resource of AGENT_RESOURCES) {
    assert.ok(
      resource.href.startsWith('/'),
      `${resource.title}: href must be site-absolute, got "${resource.href}"`
    );
    assert.ok(resource.mediaType.length > 0, `${resource.title}: mediaType`);
    assert.ok(resource.title.length > 0, 'title');
    assert.ok(
      resource.description.length > 0,
      `${resource.title}: description`
    );
  }
});

test('the machine-readable entry points an agent looks for are published', () => {
  const hrefs = AGENT_RESOURCES.map((resource) => {
    return resource.href;
  });

  for (const href of [
    '/openapi.json',
    '/errors.json',
    '/llms.txt',
    '/llms-full.txt',
    '/sitemap.xml',
  ]) {
    assert.ok(hrefs.includes(href), `${href} must be listed`);
  }

  assert.equal(new Set(hrefs).size, hrefs.length, 'hrefs must be unique');
});

test('the 404 markdown body names the requested path and links recovery targets', () => {
  const markdown = buildNotFoundMarkdown({ pathname: '/docs/does-not-exist' });

  assert.match(markdown, /^# 404/m);
  assert.match(markdown, /\/docs\/does-not-exist/);
  assert.match(markdown, /\]\(\/llms\.txt\)/);
  assert.match(markdown, /\]\(\/sitemap\.xml\)/);
  assert.match(markdown, /\]\(\/openapi\.json\)/);
  assert.match(markdown, /\]\(\/docs\/introduction\)/);
  // Kept short on purpose: agents recover from a map, not from a second site.
  assert.ok(
    markdown.length < 2000,
    `404 markdown body should stay short, got ${markdown.length} chars`
  );
});

test('the 404 markdown body stands alone when no path is known', () => {
  const markdown = buildNotFoundMarkdown({});

  assert.match(markdown, /^# 404/m);
  assert.doesNotMatch(markdown, /undefined/);
});

test('every recovery target is a site-absolute path with a hint', () => {
  assert.ok(RECOVERY_TARGETS.length >= 3);

  for (const target of RECOVERY_TARGETS) {
    assert.ok(target.href.startsWith('/'), target.href);
    assert.ok(target.label.length > 0, target.href);
    assert.ok(target.hint.length > 0, target.href);
  }
});

test('the standalone Markdown 404 body is published as a static file', () => {
  assert.equal(NOT_FOUND_MARKDOWN_HREF, '/404.md');
});

test('the static build-time 404 route is not reported as the missing path', () => {
  // The 404 page is prerendered at /404.html, so the build-time location is a
  // placeholder, not the URL a visitor asked for. Client-side hydration
  // supplies the real one.
  assert.equal(resolveMissingPathname({ pathname: '/404.html' }), undefined);
  assert.equal(resolveMissingPathname({ pathname: '/404' }), undefined);
  assert.equal(
    resolveMissingPathname({ pathname: '/docs/nope' }),
    '/docs/nope'
  );
});
