import * as fs from 'node:fs';
import * as path from 'node:path';

import createDebug from 'debug';

const log = createDebug('soat:docs');

export type DocPage = {
  path: string;
  title: string;
  description: string;
};

export type DocContent = {
  path: string;
  title: string;
  content: string;
};

const getDocsPath = () => {
  return (
    process.env.DOCS_PATH ??
    path.resolve(process.cwd(), 'packages/website/docs')
  );
};

const parseTitle = (content: string): string => {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Untitled';
};

const parseDescription = (content: string): string => {
  const lines = content.split('\n');
  let foundTitle = false;
  const paragraphLines: string[] = [];

  for (const line of lines) {
    if (!foundTitle) {
      if (line.startsWith('# ')) foundTitle = true;
      continue;
    }
    if (line.trim() === '') {
      if (paragraphLines.length > 0) break;
      continue;
    }
    if (
      line.startsWith('import ') ||
      line.startsWith('#') ||
      line.startsWith('<!--') ||
      line.startsWith('---')
    )
      continue;
    paragraphLines.push(line.trim());
  }

  return paragraphLines.join(' ').slice(0, 300);
};

const walkDocs = (dir: string, baseDir: string): DocPage[] => {
  const results: DocPage[] = [];

  if (!fs.existsSync(dir)) {
    log('docs directory not found: %s', dir);
    return results;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDocs(fullPath, baseDir));
    } else if (entry.name.endsWith('.md')) {
      const relativePath = path
        .relative(baseDir, fullPath)
        .replace(/\.md$/, '');
      const content = fs.readFileSync(fullPath, 'utf-8');
      results.push({
        path: relativePath,
        title: parseTitle(content),
        description: parseDescription(content),
      });
    }
  }

  return results.sort((a, b) => {
    return a.path.localeCompare(b.path);
  });
};

export const listDocs = (): DocPage[] => {
  const docsPath = getDocsPath();
  log('listDocs: docsPath=%s', docsPath);
  return walkDocs(docsPath, docsPath);
};

export const findDoc = (args: { path: string }): DocContent | null => {
  const docsPath = getDocsPath();
  log('findDoc: path=%s', args.path);

  const safePath = path.normalize(args.path).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(docsPath, `${safePath}.md`);
  const resolvedDocsPath = path.resolve(docsPath);

  if (!path.resolve(fullPath).startsWith(resolvedDocsPath + path.sep)) {
    log('findDoc: path traversal attempt: %s', args.path);
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    log('findDoc: file not found: %s', fullPath);
    return null;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  return {
    path: safePath,
    title: parseTitle(content),
    content,
  };
};
