import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  ensureMarkdownTwins,
  injectAlternateLink,
  markdownTwinOf,
  redirectTargetOf,
} from './advertiseMarkdownTwins';

test('a page directory maps to the Markdown twin the llms plugin emits', () => {
  assert.deepEqual(
    markdownTwinOf({ htmlRelativePath: 'docs/introduction/index.html' }),
    {
      markdownRelativePath: 'docs/introduction.md',
      href: '/docs/introduction.md',
    }
  );

  assert.deepEqual(
    markdownTwinOf({
      htmlRelativePath: 'docs/api/agents/create-agent/index.html',
    }),
    {
      markdownRelativePath: 'docs/api/agents/create-agent.md',
      href: '/docs/api/agents/create-agent.md',
    }
  );
});

test('pages with no page directory have no twin', () => {
  assert.equal(markdownTwinOf({ htmlRelativePath: 'index.html' }), null);
  assert.equal(markdownTwinOf({ htmlRelativePath: 'docs/x.html' }), null);
});

test('the 404 page is advertised against the generated recovery map', () => {
  // Not derived from its path: Docusaurus emits a bare `404.html`, and the twin
  // is `/404.md`, written by generateAgentSurfaces. An agent that lands on a
  // dead URL has no other way to ask for the Markdown recovery body.
  assert.deepEqual(markdownTwinOf({ htmlRelativePath: '404.html' }), {
    markdownRelativePath: '404.md',
    href: '/404.md',
  });
});

test('the alternate link is injected once, just before </head>', () => {
  const html =
    '<!doctype html><html><head><title>x</title></head><body>y</body></html>';

  const injected = injectAlternateLink({
    html,
    href: '/docs/introduction.md',
  });

  assert.match(
    injected,
    /<link rel="alternate" type="text\/markdown" href="\/docs\/introduction\.md"\/><\/head>/
  );
  assert.equal(
    injectAlternateLink({ html: injected, href: '/docs/introduction.md' }),
    injected,
    'injection must be idempotent'
  );
});

test('html without a head is left untouched', () => {
  const html = '<p>fragment</p>';
  assert.equal(injectAlternateLink({ html, href: '/x.md' }), html);
});

test('the redirect target of a stub page is read from its meta refresh', () => {
  // What `@docusaurus/plugin-client-redirects` emits for a moved page. It is
  // the only content such a page has, and it is what its Markdown twin says.
  const stub = [
    '<!DOCTYPE html><html><head>',
    '<meta http-equiv="refresh" content="0; url=/docs/self-hosting/configuration">',
    '<link rel="canonical" href="/docs/self-hosting/configuration" />',
    '</head></html>',
  ].join('');

  assert.equal(
    redirectTargetOf({ html: stub }),
    '/docs/self-hosting/configuration'
  );

  assert.equal(
    redirectTargetOf({ html: '<html><head><title>x</title></head></html>' }),
    null
  );
});

test('a twin the llms plugin wrote elsewhere is copied to the page path', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twins-'));

  // A folder-index page: the plugin names the file after the doc id, so the
  // twin sits inside the page directory instead of beside it.
  fs.mkdirSync(path.join(outDir, 'docs/mcp'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'docs/mcp/index.html'), '<head></head>');
  fs.writeFileSync(path.join(outDir, 'docs/mcp/mcp.md'), '# MCP\n');

  // A page under a route base path: the plugin drops the prefix.
  fs.mkdirSync(path.join(outDir, 'docs/mcp/tools/agents'), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'docs/mcp/tools/agents/index.html'),
    '<head></head>'
  );
  fs.mkdirSync(path.join(outDir, 'mcp/tools'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'mcp/tools/agents.md'), '# Agents\n');

  const { copied } = ensureMarkdownTwins({ outDir });

  assert.equal(copied, 2);
  assert.equal(
    fs.readFileSync(path.join(outDir, 'docs/mcp.md'), 'utf-8'),
    '# MCP\n'
  );
  assert.equal(
    fs.readFileSync(path.join(outDir, 'docs/mcp/tools/agents.md'), 'utf-8'),
    '# Agents\n'
  );
  // Copied, not moved: the URL the plugin published is linked from llms.txt.
  assert.ok(fs.existsSync(path.join(outDir, 'mcp/tools/agents.md')));

  fs.rmSync(outDir, { recursive: true });
});

test('a redirect stub gets a twin that names where the page went', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twins-'));
  fs.mkdirSync(path.join(outDir, 'docs/old-page'), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'docs/old-page/index.html'),
    '<head><meta http-equiv="refresh" content="0; url=/docs/new-page"></head>'
  );

  const { written } = ensureMarkdownTwins({ outDir });

  assert.equal(written, 1);
  const twin = fs.readFileSync(path.join(outDir, 'docs/old-page.md'), 'utf-8');
  // An agent following a stale link with `Accept: text/markdown` would
  // otherwise get a meta refresh it does not run, or a 404.
  assert.match(twin, /\/docs\/new-page/);

  fs.rmSync(outDir, { recursive: true });
});

test('a page with no Markdown anywhere is left without a twin', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twins-'));
  fs.mkdirSync(path.join(outDir, 'benchmark'), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'benchmark/index.html'),
    '<head></head><body>interactive</body>'
  );

  assert.deepEqual(ensureMarkdownTwins({ outDir }), { copied: 0, written: 0 });
  assert.ok(!fs.existsSync(path.join(outDir, 'benchmark.md')));

  fs.rmSync(outDir, { recursive: true });
});
