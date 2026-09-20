/**
 * Pure helpers for the file "key" model: a file is addressed by a directory
 * `prefix` and a `filename`, combined into a normalized full `path` (its key).
 * No I/O or DB access here — keep this module side-effect free.
 */
import { DomainError } from '../errors';

export const normalizePath = (p: string): string => {
  let normalized = p.trim();
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, '/');
  // Resolve . and ..
  const parts = normalized.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length === 0) {
        throw new Error('Path traversal above root is not allowed');
      }
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  // Strip trailing slash (but keep root /)
  const result = '/' + resolved.join('/');
  return result;
};

/**
 * The `LIKE` pattern that selects everything filed **under** a directory.
 *
 * The prefix is a path boundary, not a substring: `/reports` matches
 * `/reports/q1.txt` and never `/reports-archive/q1.txt`, which is what makes it
 * safe for a caller that uses a path segment as a grouping key. `/` selects
 * everything.
 *
 * `%` and `_` in the caller's prefix are escaped, so a prefix of `/%` is the
 * literal directory `/%` rather than a wildcard matching every row — a filter
 * that silently widens to "everything" is worse than one that matches nothing.
 */
export const pathPrefixPattern = (prefix: string): string => {
  const normalized = normalizePath(prefix);
  const directory = normalized === '/' ? '/' : `${normalized}/`;
  return `${directory.replace(/[\\%_]/g, '\\$&')}%`;
};

/**
 * Derives the filename (download name) from a logical path: its last segment.
 * `/temas/report.txt` → `report.txt`. Returns undefined for an empty/null path.
 */
export const filenameFromPath = (p: string | null): string | undefined => {
  if (!p) return undefined;
  const segments = p.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
};

/**
 * Derives the directory prefix from a logical path: everything but the last
 * segment. `/temas/report.txt` → `/temas`, `/report.txt` → `/`. Undefined for
 * an empty/null path.
 */
export const prefixFromPath = (p: string | null): string | undefined => {
  if (!p) return undefined;
  const segments = p.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  return '/' + segments.slice(0, -1).join('/');
};

/**
 * Builds the full path (key) from a directory prefix and a filename:
 * `prefix` + `/` + `filename`, normalized. `prefix` defaults to `/` (root).
 * Returns null when there is nothing to key on (no filename and root prefix).
 */
export const buildPath = (args: {
  prefix?: string;
  filename?: string;
}): string | null => {
  const prefix =
    args.prefix !== undefined && args.prefix.trim() !== '' ? args.prefix : '/';
  if (args.filename) {
    return normalizePath(`${prefix}/${args.filename}`);
  }
  const normalized = normalizePath(prefix);
  return normalized === '/' ? null : normalized;
};

/**
 * Recomputes a file's key (path) and filename when its prefix and/or filename
 * change, falling back to the current values for whichever is not provided.
 */
export const rebuildKey = (args: {
  currentPath: string | null;
  currentFilename?: string;
  prefix?: string;
  filename?: string;
}): { path: string | null; filename: string | undefined } => {
  const prefix = args.prefix ?? prefixFromPath(args.currentPath) ?? '/';
  const filename =
    args.filename ?? args.currentFilename ?? filenameFromPath(args.currentPath);
  return { path: buildPath({ prefix, filename }), filename };
};

/**
 * The reserved root for every file and document the runtime writes on the
 * caller's behalf. One directory per module beneath it, named after the
 * module's URL segment.
 *
 * A path is the marker, rather than a tag or `metadata`: `metadata` is
 * contractually untouched by the server and a tag bag is caller-replaceable, so
 * neither survives a caller who edits it. A path also brings prefix search,
 * directory listing, storage bucketing and IAM path globs with it.
 */
export const SYSTEM_ROOT = '/.system';

declare const systemPathBrand: unique symbol;

/**
 * A location under {@link SYSTEM_ROOT}. `systemPath` is its only constructor,
 * so a writer that spells the reserved root as a plain string cannot reach the
 * arguments that expect one — which is what keeps a second convention from
 * appearing the way `/traces/` did.
 */
export type SystemPath = string & { readonly [systemPathBrand]: true };

/** A module directory is one plain segment, so the root stays one level deep. */
const MODULE_SEGMENT = /^[a-z0-9-]+$/;

export const systemPath = (args: {
  module: string;
  leaf: string;
}): SystemPath => {
  if (!MODULE_SEGMENT.test(args.module)) {
    throw new Error(
      `systemPath: module must be a single path segment of [a-z0-9-], got "${args.module}"`
    );
  }
  const directory = `${SYSTEM_ROOT}/${args.module}`;
  const path = normalizePath(`${directory}/${args.leaf}`);
  // `normalizePath` resolves `..` rather than refusing it, so a leaf can walk
  // out of its module — and out of the root — without ever tripping its
  // above-root guard.
  if (!path.startsWith(`${directory}/`)) {
    throw new Error(`systemPath: leaf "${args.leaf}" escapes ${directory}`);
  }
  return path as SystemPath;
};

/** Whether a stored path is the runtime's. The root itself counts. */
export const isSystemPath = (path: string | null | undefined): boolean => {
  if (!path) return false;
  const normalized = normalizePath(path);
  return normalized === SYSTEM_ROOT || normalized.startsWith(`${SYSTEM_ROOT}/`);
};

/**
 * Gate for every caller-supplied path. Returns it unchanged, or refuses a write
 * into the reserved root — checked after normalization, so `.system/x` and
 * `/a/../.system/x` are refused alongside the plain spelling.
 */
export const assertCallerPath = <T extends string | null | undefined>(
  path: T
): T => {
  if (path && isSystemPath(path)) {
    throw new DomainError(
      'RESERVED_PATH',
      `'${SYSTEM_ROOT}/' is reserved for platform-written files and cannot be written to.`
    );
  }
  return path;
};
