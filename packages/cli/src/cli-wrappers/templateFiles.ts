import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * File references in a template read from disk, resolved against the
 * template's own directory so a template and the files it names move together.
 *
 * - `{ file: "path" }` becomes that file's text.
 * - `{ files: "glob" }` becomes a map from each match's path below the glob's
 *   fixed prefix (`docs/**` → `guide/start.md`) to its text — the shape a
 *   `for_each` takes.
 *
 * Only a lone key is a reference, so a property genuinely named `file` keeps
 * its value. A missing file or a glob that matches nothing stops the command
 * before any request: an empty `for_each` would delete every instance.
 */

const GLOB_CHARS = /[*?[\]{}]/;

const loneString = (args: {
  node: unknown;
  key: 'file' | 'files';
}): string | undefined => {
  const { node, key } = args;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const entries = Object.entries(node);
  if (entries.length !== 1 || entries[0][0] !== key) return;
  return typeof entries[0][1] === 'string' ? entries[0][1] : undefined;
};

const readText = (args: { file: string }): string => {
  try {
    return fs.readFileSync(args.file, 'utf8');
  } catch {
    throw new Error(`Unable to read file: ${args.file}`);
  }
};

/** The leading segments of a glob that hold no wildcard. */
const fixedPrefix = (pattern: string): string => {
  const segments = pattern.split('/');
  const firstGlob = segments.findIndex((segment) => {
    return GLOB_CHARS.test(segment);
  });
  return segments.slice(0, firstGlob === -1 ? -1 : firstGlob).join('/');
};

const readGlob = (args: {
  pattern: string;
  baseDir: string;
}): Record<string, string> => {
  const root = path.resolve(args.baseDir, fixedPrefix(args.pattern));
  const matches = fs
    .globSync(args.pattern, { cwd: args.baseDir })
    .map((match) => {
      return path.resolve(args.baseDir, match);
    })
    .filter((file) => {
      return fs.statSync(file).isFile();
    })
    .sort();
  if (matches.length === 0) {
    throw new Error(
      `Glob '${args.pattern}' matched no files under ${args.baseDir}`
    );
  }
  return Object.fromEntries(
    matches.map((file) => {
      const key = path.relative(root, file).split(path.sep).join('/');
      return [key, readText({ file })];
    })
  );
};

export const resolveTemplateFiles = (args: {
  node: unknown;
  baseDir: string;
}): unknown => {
  const { node, baseDir } = args;

  const file = loneString({ node, key: 'file' });
  if (file !== undefined)
    return readText({ file: path.resolve(baseDir, file) });

  const pattern = loneString({ node, key: 'files' });
  if (pattern !== undefined) return readGlob({ pattern, baseDir });

  if (Array.isArray(node)) {
    return node.map((item) => {
      return resolveTemplateFiles({ node: item, baseDir });
    });
  }
  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        return [key, resolveTemplateFiles({ node: value, baseDir })];
      })
    );
  }
  return node;
};
