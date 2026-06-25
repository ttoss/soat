/**
 * Pure helpers for the file "key" model: a file is addressed by a directory
 * `prefix` and a `filename`, combined into a normalized full `path` (its key).
 * No I/O or DB access here — keep this module side-effect free.
 */

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
