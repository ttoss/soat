import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeApiPage } from './normalizeApiDescriptions';
import { DESCRIPTION_MAX, DESCRIPTION_MIN } from './seoMetadata';

const apiPage = (args: { description: string; method?: string }) => {
  return [
    '---',
    'id: get-actor',
    'title: "Get an actor by ID"',
    `description: ${JSON.stringify(args.description)}`,
    `sidebar_class_name: "${args.method ?? 'get'} api-method"`,
    '---',
    '',
    '<MethodEndpoint',
    `  method={"${args.method ?? 'get'}"}`,
    '  path={"/api/v1/actors/{actor_id}"}',
    '  context={"endpoint"}',
    '>',
    '</MethodEndpoint>',
    '',
  ].join('\n');
};

const descriptionOf = (source: string): string => {
  const match = /^description: (.*)$/m.exec(source);
  assert.ok(match, 'no description line');
  return JSON.parse(match[1]) as string;
};

test('a short operation description is completed with its endpoint', () => {
  const out = normalizeApiPage({
    source: apiPage({ description: 'Returns an actor by its ID' }),
  });

  assert.equal(
    descriptionOf(out),
    'Returns an actor by its ID. GET /api/v1/actors/{actor_id} in the SOAT REST API.'
  );
});

test('a long operation description keeps its leading sentences', () => {
  const long = `Streams a project's activity entries as newline-delimited JSON. ${'Each entry carries its kind and severity. '.repeat(8)}`;
  const description = descriptionOf(
    normalizeApiPage({ source: apiPage({ description: long }) })
  );

  assert.ok(description.length <= DESCRIPTION_MAX, description);
  assert.ok(
    description.startsWith(
      "Streams a project's activity entries as newline-delimited JSON."
    ),
    description
  );
});

test('markdown in an operation description is reduced to text', () => {
  const description = descriptionOf(
    normalizeApiPage({
      source: apiPage({
        description:
          'Returns the [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) Protected Resource Metadata for `/mcp`.',
      }),
    })
  );

  assert.equal(
    description,
    'Returns the RFC 9728 Protected Resource Metadata for /mcp.'
  );
});

test('an operation with no description falls back to its title', () => {
  const description = descriptionOf(
    normalizeApiPage({ source: apiPage({ description: '' }) })
  );

  assert.ok(description.length >= DESCRIPTION_MIN, description);
  assert.ok(description.startsWith('Get an actor by ID.'), description);
});

test('a page that is not an operation is left as it is', () => {
  const info = '---\nid: soat-actors-api\ntitle: "Actors"\n---\n\nIntro.\n';

  assert.equal(normalizeApiPage({ source: info }), info);
});
