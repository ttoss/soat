import assert from 'node:assert/strict';
import { test } from 'node:test';

import { injectAlternateLink, markdownTwinOf } from './advertiseMarkdownTwins';

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
  assert.equal(markdownTwinOf({ htmlRelativePath: '404.html' }), null);
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
