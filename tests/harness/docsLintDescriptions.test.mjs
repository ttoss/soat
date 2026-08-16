import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  checkDescriptions,
  frontMatterDescription,
} from '../../scripts/docs-lint.mjs';

/**
 * Check 7: every authored doc carries a non-empty, unique `description` front
 * matter field.
 *
 * The description is what search engines and AI crawlers quote for the page —
 * it is the page's one-line answer. Docusaurus falls back to the site tagline
 * when it is missing, which silently gives every undescribed page the same
 * snippet. Coverage is 100% today only by discipline; this check turns it into
 * an invariant, and the duplicate rule catches the copy-paste that would make
 * two pages compete for the same query.
 */
describe('docs-lint frontMatterDescription', () => {
  test('reads a plain description', () => {
    assert.equal(
      frontMatterDescription(
        '---\ndescription: Agents run loops.\nsidebar_position: 1\n---\n\n# Agents\n'
      ),
      'Agents run loops.'
    );
  });

  test('strips single and double quotes', () => {
    assert.equal(
      frontMatterDescription("---\ndescription: 'Quoted: yes.'\n---\n"),
      'Quoted: yes.'
    );
    assert.equal(
      frontMatterDescription('---\ndescription: "Double."\n---\n'),
      'Double.'
    );
  });

  test('returns null when the field is missing or empty', () => {
    assert.equal(
      frontMatterDescription('---\nsidebar_position: 1\n---\n'),
      null
    );
    assert.equal(frontMatterDescription("---\ndescription: ''\n---\n"), null);
    assert.equal(frontMatterDescription('# No front matter at all\n'), null);
  });

  test('ignores a description-looking line outside the front matter', () => {
    assert.equal(
      frontMatterDescription('# Page\n\ndescription: not front matter\n'),
      null
    );
  });
});

describe('docs-lint checkDescriptions', () => {
  test('passes docs with unique non-empty descriptions', () => {
    const violations = checkDescriptions([
      { rel: 'docs/a.md', text: '---\ndescription: Alpha.\n---\n' },
      { rel: 'docs/b.md', text: '---\ndescription: Beta.\n---\n' },
    ]);
    assert.deepEqual(violations, []);
  });

  test('flags a missing description', () => {
    const violations = checkDescriptions([
      { rel: 'docs/a.md', text: '---\nsidebar_position: 2\n---\n# A\n' },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /docs\/a\.md/);
    assert.match(violations[0], /missing description/);
  });

  test('flags a duplicate description on every file that shares it', () => {
    const violations = checkDescriptions([
      { rel: 'docs/a.md', text: '---\ndescription: Same.\n---\n' },
      { rel: 'docs/b.md', text: '---\ndescription: Same.\n---\n' },
      { rel: 'docs/c.md', text: '---\ndescription: Unique.\n---\n' },
    ]);
    assert.equal(violations.length, 2);
    assert.match(violations[0], /duplicate description/);
    assert.match(violations[1], /duplicate description/);
  });
});
