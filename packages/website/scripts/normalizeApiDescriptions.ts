import * as fs from 'node:fs';
import * as path from 'node:path';

import { fitDescription, plainText } from './seoMetadata';

/**
 * `docusaurus gen-api-docs` copies each operation's OpenAPI `description`
 * into the page's meta description verbatim: a one-line summary is too short
 * to stand in a search result, a multi-paragraph contract far too long. This
 * pass, run right after it, rewrites each operation page's `description` to
 * fit `seoMetadata.ts`, naming the endpoint when the text alone is too short.
 */

const API_DOCS_DIR = path.resolve(__dirname, '../docs/api');

const frontMatterValue = (args: {
  frontMatter: string;
  key: string;
}): string | undefined => {
  const match = new RegExp(`^${args.key}: (.*)$`, 'm').exec(args.frontMatter);
  if (!match) return undefined;
  const raw = match[1].trim();
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
};

/** One generated operation page with its meta description fitted. */
export const normalizeApiPage = (args: { source: string }): string => {
  const match = /^---\n([\s\S]*?)\n---/.exec(args.source);
  if (!match) return args.source;
  const frontMatter = match[1];
  const method = /^sidebar_class_name: "(\w+) api-method"$/m.exec(frontMatter);
  const endpoint = /\bpath=\{"([^"]+)"\}/.exec(args.source);
  if (!method || !endpoint) return args.source;

  const description = frontMatterValue({ frontMatter, key: 'description' });
  const title = frontMatterValue({ frontMatter, key: 'title' }) ?? '';
  const fitted = fitDescription({
    text: plainText({ markdown: description || title }),
    context: `${method[1].toUpperCase()} ${endpoint[1]} in the SOAT REST API.`,
  });
  const line = `description: ${JSON.stringify(fitted)}`;
  const nextFrontMatter = /^description: .*$/m.test(frontMatter)
    ? frontMatter.replace(/^description: .*$/m, line)
    : `${frontMatter}\n${line}`;

  return args.source.replace(frontMatter, nextFrontMatter);
};

const apiPages = (dir: string): string[] => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return apiPages(full);
    return entry.name.endsWith('.api.mdx') ? [full] : [];
  });
};

const normalize = (): void => {
  const pages = apiPages(API_DOCS_DIR);
  for (const file of pages) {
    const source = fs.readFileSync(file, 'utf-8');
    const next = normalizeApiPage({ source });
    if (next !== source) fs.writeFileSync(file, next, 'utf-8');
  }
  process.stdout.write(
    `[api-descriptions] fitted ${pages.length} operation pages\n`
  );
};

// Importing this module — as the test does — must not write anything; only
// running it as a script rewrites the pages.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  normalize();
}
