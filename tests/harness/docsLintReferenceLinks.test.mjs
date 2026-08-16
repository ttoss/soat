import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  operationSlug,
  scanReferenceMentions,
} from '../../scripts/docs-lint.mjs';

/**
 * The two halves of docs-lint's API-reference-link check.
 *
 * `operationSlug` reproduces the slug `docusaurus-plugin-openapi-docs` derives
 * from an `operationId`. It is the address of every link the check demands, and
 * nothing in this repo stores it: the generated pages under `docs/api/` are
 * gitignored, so a wrong slug is invisible until a website build runs — which
 * `pr.yml` skips entirely for a Markdown-only PR (its `code` filter excludes
 * Markdown). That is
 * the gap this check exists to close, so the slug rule is pinned here rather
 * than trusted.
 *
 * `scanReferenceMentions` finds the endpoint tokens in a page. Both of its
 * failure directions are bad in the same way as the body-field check: reading a
 * token inside a fenced block (or one that is already a link) reports work that
 * must not be done, and missing one lets an unlinked mention through.
 */
describe('docs-lint operationSlug', () => {
  test('kebab-cases an operationId', () => {
    assert.equal(operationSlug('listUsers'), 'list-users');
    assert.equal(
      operationSlug('completeIngestionCallback'),
      'complete-ingestion-callback'
    );
  });

  test('splits a digit run into its own word, as lodash kebabCase does', () => {
    // `downloadFileBase64` addresses `download-file-base-64.api.mdx`. A naive
    // camel-boundary split yields `download-file-base64`, a 404 that only a
    // full website build would surface.
    assert.equal(operationSlug('downloadFileBase64'), 'download-file-base-64');
    assert.equal(operationSlug('uploadFileBase64'), 'upload-file-base-64');
  });

  test('keeps an acronym run together', () => {
    assert.equal(operationSlug('createAIProvider'), 'create-ai-provider');
  });
});

describe('docs-lint scanReferenceMentions', () => {
  const tokensOf = (text) => {
    return scanReferenceMentions(text).map((m) => {
      return `${m.method} ${m.path}${m.linked ? ' [linked]' : ''}`;
    });
  };

  test('reads a method + path in inline code', () => {
    assert.deepEqual(
      tokensOf(
        'Poll `GET /api/v1/documents/{document_id}/status` until ready.'
      ),
      ['get /api/v1/documents/{document_id}/status']
    );
  });

  test('reads a path written without the /api/v1 prefix', () => {
    // Both spellings appear across the docs; the specs declare the prefixed
    // form, so the scanner must surface the path as written and leave
    // normalization to the resolver.
    assert.deepEqual(
      tokensOf('Call `POST /documents/ingest` with the file id.'),
      ['post /documents/ingest']
    );
  });

  test('reports a token that is already a link as linked', () => {
    assert.deepEqual(
      tokensOf(
        '| [`POST /agents/{agent_id}/generate`](../modules/agents.md#background-generation) | … |'
      ),
      ['post /agents/{agent_id}/generate [linked]']
    );
  });

  test('ignores tokens inside a fenced code block', () => {
    // A fenced block is copy-pasted verbatim; a Markdown link inside one is
    // literal text, so a mention there must never be reported as work.
    const text = [
      'Prose mentions `GET /documents`.',
      '```bash',
      '# `GET /files` in a comment',
      '```',
    ].join('\n');
    assert.deepEqual(tokensOf(text), ['get /documents']);
  });

  test('drops a query string from the path', () => {
    assert.deepEqual(
      tokensOf('See `GET /api/v1/usage/meters?source=eval` for…'),
      ['get /api/v1/usage/meters']
    );
  });

  test('ignores a method named without a path, and prose', () => {
    assert.deepEqual(
      tokensOf('Every mutating `POST` request is audited. `GET` too.'),
      []
    );
  });

  test('records the line number of each mention', () => {
    const text = ['intro', '', 'Call `POST /documents`.'].join('\n');
    assert.deepEqual(
      scanReferenceMentions(text).map((m) => {
        return m.line;
      }),
      [3]
    );
  });
});
