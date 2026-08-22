import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeMdx } from './mdx';

test('MDX-hostile characters outside code spans are escaped', () => {
  // A bare `{` opens a JSX expression and a bare `<` opens a tag. Registry and
  // schema descriptions carry both — `{{secret:…}}` tokens, `<key>`
  // placeholders — and each one fails the build with an acorn parse error
  // naming a generated file nobody edited.
  assert.equal(
    escapeMdx('a {{secret:x}} and <key>'),
    'a \\{\\{secret:x\\}\\} and \\<key\\>'
  );
  assert.equal(escapeMdx('plain text'), 'plain text');
  assert.equal(escapeMdx(''), '');
});

test('inline code spans are left verbatim', () => {
  // CONVERTER_OUTPUT_INVALID documents its shape as a code span full of braces.
  // MDX does not parse inside a span, so escaping there would render literal
  // backslashes to the reader.
  assert.equal(
    escapeMdx('Expected `{ pages: [{ text }] }`, or nothing.'),
    'Expected `{ pages: [{ text }] }`, or nothing.'
  );
  assert.equal(
    escapeMdx('`<a>` but not <b>'),
    '`<a>` but not \\<b\\>'
  );
});

test('a stray backtick run does not swallow the rest of the line', () => {
  // TEXT_ENCODED_TOOL_CALL says "a ```json block containing {…}". A pairwise
  // split reads the first two of those three backticks as an empty span and
  // treats everything after as code — escaping none of it, which is exactly how
  // the second round of this bug reached the build.
  assert.equal(
    escapeMdx('a ```json block containing {"a": "<b>"}'),
    'a ```json block containing \\{"a": "\\<b\\>"\\}'
  );
});

test('a multi-backtick span is matched by its own run length', () => {
  assert.equal(escapeMdx('``a ` b`` and {c}'), '``a ` b`` and \\{c\\}');
});
