import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  markdownPageNames,
  stripFrontMatter,
  twinFileName,
} from './generatePageTwins';

test('front matter is stripped so the twin starts at the first heading', () => {
  const source = [
    '---',
    'title: About SOAT',
    'description: What SOAT is.',
    '---',
    '',
    '# About SOAT',
    '',
    'Body.',
    '',
  ].join('\n');

  assert.equal(stripFrontMatter({ source }), '# About SOAT\n\nBody.\n');
});

test('a page with no front matter is passed through unchanged', () => {
  const source = '# About SOAT\n\nBody.\n';
  assert.equal(stripFrontMatter({ source }), source);
});

test('a --- rule inside the body is not mistaken for front matter', () => {
  const source = '# Title\n\nBefore.\n\n---\n\nAfter.\n';
  assert.equal(stripFrontMatter({ source }), source);
});

test('the twin of a page is the page name plus .md', () => {
  assert.equal(twinFileName({ pageName: 'about' }), 'about.md');
});

test('every Markdown page under src/pages is picked up', () => {
  // The list is derived, not hand-maintained: a page added to src/pages gets a
  // twin without anyone remembering to declare it. `viewerRequest.test.ts`
  // relies on that — a page with neither a twin nor an HTML-only declaration
  // is negotiated into a 404.
  const names = markdownPageNames();

  for (const expected of ['about', 'contact', 'privacy', 'developers']) {
    assert.ok(
      names.includes(expected),
      `${expected} is missing from the generated Markdown twins`
    );
  }
});
