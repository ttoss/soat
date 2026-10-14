import { join } from 'node:path';

export const ROOT = new URL('../..', import.meta.url).pathname;
export const CLI_DIR = join(ROOT, 'packages/cli');
export const OPENAPI_DIR = join(ROOT, 'packages/server/src/rest/openapi/v1');
export const CLI_MANIFEST = join(CLI_DIR, 'src/generated/routes.ts');

/** Canonicalize a flag/param name so snake, kebab, and camel spellings match —
 * the CLI's own parser is lenient the same way (see `toCanonical` in index.ts). */
export const canonical = (s) => {
  return s.replace(/[-_]([a-z0-9])/g, (_, c) => {
    return c.toUpperCase();
  });
};

/** Slice `key: [ ... ]` out of a line, counting brackets so a nested array
 * inside a flag description does not end the match early. */
export const sliceArray = (line, key) => {
  const start = line.indexOf(`${key}: [`);
  if (start === -1) return '';
  let depth = 0;
  const from = line.indexOf('[', start);
  for (let i = from; i < line.length; i++) {
    if (line[i] === '[') depth++;
    else if (line[i] === ']') {
      depth--;
      if (depth === 0) return line.slice(from, i + 1);
    }
  }
  return '';
};

/**
 * Join shell line-continuations so a multi-line command is read as one, starting
 * one only on a line `startsCommand` accepts.
 */
export const joinContinuations = (lines, startsCommand) => {
  const out = [];
  let buf = null;
  let startLine = 0;

  for (const [idx, line] of lines.entries()) {
    const trimmed = line.trimEnd();
    if (buf !== null) {
      buf += ` ${trimmed.replace(/\\$/, '')}`;
      if (!trimmed.endsWith('\\')) {
        out.push({ text: buf, line: startLine });
        buf = null;
      }
      continue;
    }
    if (!startsCommand.test(trimmed)) continue;
    startLine = idx + 1;
    if (trimmed.endsWith('\\')) buf = trimmed.replace(/\\$/, '');
    else out.push({ text: trimmed, line: startLine });
  }

  return out;
};
