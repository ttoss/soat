import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A route reads `tool_context` off a request body only through
 * `parseToolContextBody` or `parseNullableToolContextBody`, typed `unknown`
 * until they narrow it. Those are where a non-string value is refused, so a
 * route that passed the field on as it arrived would answer `202` and fail the
 * work it queued, or forward a value nobody checked.
 */

const ROUTES_DIR = join(__dirname, '../../../../src/rest/v1');

const TYPE_MEMBER = /^\s*tool_context\?: unknown;$/;

const PARSED_READ =
  /parse(Nullable)?ToolContextBody\(\s*[A-Za-z_]\w*\.tool_context\s*\)/g;

const isComment = (line: string): boolean => {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
};

const routeFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
};

describe('a route reads tool_context through the shared parser', () => {
  test('every mention is an unknown-typed member or a parsed read', () => {
    const offenders: string[] = [];

    for (const file of routeFiles(ROUTES_DIR)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line.includes('tool_context') || isComment(line)) continue;
        if (TYPE_MEMBER.test(line)) continue;
        if (!line.replace(PARSED_READ, '').includes('tool_context')) continue;
        offenders.push(`${file.slice(ROUTES_DIR.length + 1)}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
