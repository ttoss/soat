import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ERROR_CODES } from '../../server/src/errors/codes';
import { docsUrlFor, resolutionFor } from '../../server/src/errors/resolutions';
import { anchorFor, renderErrorCodesPage } from './generateErrorCodesPage';
import { escapeMdx } from './mdx';

const page = renderErrorCodesPage();

test('every code in the registry gets a section and a summary row', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    assert.ok(page.includes(`### ${code}`), `no section for ${code}`);
    assert.ok(
      page.includes(`[\`${code}\`](#${anchorFor({ code })})`),
      `no summary row for ${code}`
    );
  }
});

test('every docs_url the server emits addresses a heading on this page', () => {
  // This is the link in every error response. If the anchor rule here and the
  // one in `docsUrlFor` ever disagree, every `docs_url` in production lands on
  // the top of the page instead of the code — a dead link that still returns
  // 200, so nothing else would catch it.
  for (const code of Object.keys(ERROR_CODES)) {
    const anchor = docsUrlFor({ code }).split('#')[1];
    assert.equal(anchor, anchorFor({ code }));
    assert.ok(page.includes(`### ${anchor.toUpperCase()}`));
  }
});

test('every section carries the same hint the API returns', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    assert.ok(
      page.includes(`**What to do:** ${escapeMdx(resolutionFor({ code }))}`),
      `hint missing or divergent for ${code}`
    );
  }
});



test('the descriptions that broke the build are escaped on the page', () => {
  for (const code of [
    'INVALID_TEMPLATE_TOKEN',
    'INVALID_TOOL_CONTEXT_KEY',
    'TEXT_ENCODED_TOOL_CALL',
  ] as const) {
    const rendered = escapeMdx(ERROR_CODES[code].description);

    assert.ok(rendered.includes('\\'), `${code}: nothing was escaped`);
    assert.ok(page.includes(rendered), `${code}: page carries unescaped text`);
  }
});
