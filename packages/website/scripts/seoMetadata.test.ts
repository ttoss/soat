import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import yaml from 'js-yaml';

import { HOME_META } from '../src/data/homepage';
import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  fitDescription,
  metadataViolations,
  plainText,
  TITLE_MAX,
} from './seoMetadata';

const WEBSITE_DIR = path.resolve(__dirname, '..');

const page = (args: { path: string; title?: string; description?: string }) => {
  return {
    path: args.path,
    title: args.title ?? `${args.path} page | SOAT`,
    description:
      args.description ??
      `The ${args.path} page of the SOAT documentation, long enough to count.`,
  };
};

test('plainText drops markdown links, code, emphasis and tags', () => {
  assert.equal(
    plainText({
      markdown:
        'Returns the [RFC 9728](https://example.com) `resource` **metadata** <br/> now.',
    }),
    'Returns the RFC 9728 resource metadata now.'
  );
});

test('plainText keeps underscores and asterisks that are part of a name', () => {
  assert.equal(
    plainText({
      markdown: 'Sets `guardrail_ids` and _this_ with *that* on the `tool_context`.',
    }),
    'Sets guardrail_ids and this with that on the tool_context.'
  );
});

test('fitDescription keeps whole sentences inside the limit', () => {
  const text = `${'A first sentence that says what the operation does. '.repeat(2)}${'Then a long tail of detail. '.repeat(10)}`;
  const fitted = fitDescription({ text, context: 'GET /api/v1/x' });

  assert.ok(fitted.length <= DESCRIPTION_MAX, fitted);
  assert.ok(fitted.endsWith('.'), fitted);
});

test('fitDescription cuts a single overlong sentence at a word', () => {
  const fitted = fitDescription({
    text: `Streams ${'every entry with its fields '.repeat(12)}to the caller`,
    context: 'GET /api/v1/x',
  });

  assert.ok(fitted.length <= DESCRIPTION_MAX, fitted);
  assert.ok(fitted.endsWith('…'), fitted);
});

test('fitDescription completes a short text with its context', () => {
  const fitted = fitDescription({
    text: 'Deletes a chat by ID.',
    context: 'DELETE /api/v1/chats/{chat_id} in the SOAT REST API.',
  });

  assert.equal(
    fitted,
    'Deletes a chat by ID. DELETE /api/v1/chats/{chat_id} in the SOAT REST API.'
  );
  assert.ok(fitted.length >= DESCRIPTION_MIN);
});

test('metadataViolations passes distinct, well-sized metadata', () => {
  assert.deepEqual(
    metadataViolations({ pages: [page({ path: '/a' }), page({ path: '/b' })] }),
    []
  );
});

test('metadataViolations names each defect and the pages it sits on', () => {
  const violations = metadataViolations({
    pages: [
      page({ path: '/a', title: 'Actors | SOAT' }),
      page({ path: '/b', title: 'Actors | SOAT' }),
      page({ path: '/c', title: `${'x'.repeat(TITLE_MAX)} | SOAT` }),
      page({ path: '/d', description: '' }),
      page({ path: '/e', description: 'Blog' }),
      page({ path: '/f', description: 'y'.repeat(DESCRIPTION_MAX + 1) }),
      page({
        path: '/g',
        description: 'The same sentence on two pages of the site.',
      }),
      page({
        path: '/h',
        description: 'The same sentence on two pages of the site.',
      }),
    ],
  });

  assert.deepEqual(violations, [
    'duplicate title "Actors | SOAT": /a, /b',
    `title over ${TITLE_MAX} characters: /c`,
    'no description: /d',
    `description under ${DESCRIPTION_MIN} characters: /e`,
    `description over ${DESCRIPTION_MAX} characters: /f`,
    `description under ${DESCRIPTION_MIN} characters: /g`,
    `description under ${DESCRIPTION_MIN} characters: /h`,
    'duplicate description "The same sentence on two pages of the site.": /g, /h',
  ]);
});

/** Every handwritten page: tracked in git, so no generator owns it. */
const handwrittenPages = (): string[] => {
  return execFileSync('git', ['ls-files', 'docs', 'src/pages'], {
    cwd: WEBSITE_DIR,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => {
      return /\.mdx?$/.test(file);
    });
};

const frontMatter = (file: string): Record<string, unknown> => {
  const source = fs.readFileSync(path.join(WEBSITE_DIR, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  return match ? ((yaml.load(match[1]) ?? {}) as Record<string, unknown>) : {};
};

test('every handwritten page states a description a search result can show whole', () => {
  const offenders = handwrittenPages()
    .map((file) => {
      const description = frontMatter(file).description;
      return {
        file,
        length: typeof description === 'string' ? description.length : 0,
      };
    })
    .filter(({ length }) => {
      return length < DESCRIPTION_MIN || length > DESCRIPTION_MAX;
    })
    .map(({ file, length }) => {
      return `${file} (${length})`;
    });

  assert.deepEqual(offenders, []);
});

test('the homepage title names SOAT once, and its description fits a snippet', () => {
  assert.equal(HOME_META.title.split('SOAT').length - 1, 1, HOME_META.title);
  assert.ok(HOME_META.title.length <= TITLE_MAX, HOME_META.title);
  assert.ok(
    HOME_META.description.length >= DESCRIPTION_MIN &&
      HOME_META.description.length <= 155,
    `${HOME_META.description.length}: ${HOME_META.description}`
  );

  const source = fs.readFileSync(
    path.join(WEBSITE_DIR, 'src/pages/index.tsx'),
    'utf8'
  );
  assert.ok(source.includes('HOME_META.title'));
  assert.ok(source.includes('HOME_META.description'));
});
