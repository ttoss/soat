import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nothing rewrites request keys any more (see `.claude/rules/case-convention.md`).
 * A handler that reads a camelCase key off the request is therefore reading a
 * name no client ever sends: the value is silently `undefined`, so the filter is
 * ignored or the request 400s on a field the caller did supply.
 *
 * Two shapes count as reading the request, because the flip to single-casing
 * left broken instances of both:
 *
 * 1. **Destructuring** it directly — `const { agentId } = ctx.query`.
 * 2. **Member access** on a `body` / `query` binding — `body.maxConcurrentRuns`,
 *    or the key named in a `hasOwnProperty.call(body, 'maxConcurrentRuns')`
 *    presence check. `PATCH /projects/:project_id` broke exactly here: the read
 *    happens inside a `parseProjectPatchFields(body)` helper, one call away from
 *    `ctx.request.body`, so a check that only looked at direct destructuring
 *    passed it.
 *
 * This is a static check on purpose. The failure it guards is a *missing* read,
 * which a per-route integration test only catches if someone remembers to
 * exercise that exact field — all of these typechecked and most passed the
 * suite. Reading the source is the only way to catch the class rather than the
 * instances.
 *
 * A camelCase key inside an **opaque bag** is not a violation and is not
 * checked: this looks only at the identifier a handler names, never at values.
 */

const V1_DIR = join(__dirname, '../../../../src/rest/v1');

/** Wire-side key of a destructuring entry: `agent_id: agentId` -> `agent_id`. */
const wireKey = (entry: string): string => {
  return entry.split(':')[0].trim();
};

const isCamelCase = (key: string): boolean => {
  return /^[a-z][A-Za-z0-9]*$/.test(key) && /[a-z][A-Z]/.test(key);
};

/**
 * Collects `const { ... } = ctx.query` / `ctx.request.body` destructuring
 * blocks. Brace-matched rather than regex-captured so a nested type annotation
 * (`ctx.query as Record<string, string | undefined>`) cannot end the block early.
 */

/** The index of the `}` matching the `{` at `braceStart`, or `-1` if unbalanced. */
const findMatchingBrace = (source: string, braceStart: number): number => {
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Which request surface a `const { ... } = <tail>` destructures, or `null`. */
const destructuredSurface = (tail: string): string | null => {
  if (/^\s*=\s*ctx\.query/.test(tail)) return 'ctx.query';
  if (/^\s*=\s*ctx\.request\.body/.test(tail)) return 'ctx.request.body';
  return null;
};

/** The camelCase destructured keys between a block's braces, at `line`. */
const camelCaseEntryKeys = (args: {
  source: string;
  braceStart: number;
  end: number;
  line: number;
  surface: string;
}): { key: string; line: number; surface: string }[] => {
  const { source, braceStart, end, line, surface } = args;
  const found: { key: string; line: number; surface: string }[] = [];

  for (const entry of source.slice(braceStart + 1, end).split(',')) {
    const cleaned = entry.split('//')[0].trim();
    if (!cleaned || cleaned.startsWith('...')) continue;

    const key = wireKey(cleaned);
    if (isCamelCase(key)) found.push({ key, line, surface });
  }

  return found;
};

const collectWireKeys = (source: string) => {
  const found: { key: string; line: number; surface: string }[] = [];
  const opener = /const\s*\{/g;

  let match: RegExpExecArray | null;

  while ((match = opener.exec(source)) !== null) {
    const braceStart = source.indexOf('{', match.index);
    const end = findMatchingBrace(source, braceStart);
    if (end === -1) continue;

    // Only care when the destructuring target is the request itself.
    const surface = destructuredSurface(source.slice(end + 1, end + 60));
    if (!surface) continue;

    const line = source.slice(0, braceStart).split('\n').length;
    found.push(
      ...camelCaseEntryKeys({ source, braceStart, end, line, surface })
    );
  }

  return found;
};

/**
 * Member access and presence checks on a `body` / `query` binding. Those two
 * names are this package's convention for the raw request, including when it is
 * threaded one call deep into a `parse*` helper — which is why the check follows
 * the identifier rather than only the `ctx.request.body` expression.
 */
const collectAccessKeys = (source: string) => {
  const found: { key: string; line: number; surface: string }[] = [];

  const patterns: { re: RegExp; group: number }[] = [
    { re: /\b(body|query)\.([a-z][A-Za-z0-9]*)\b/g, group: 2 },
    {
      re: /hasOwnProperty\.call\(\s*(body|query)\s*,\s*'([^']+)'/g,
      group: 2,
    },
  ];

  for (const [index, text] of source.split('\n').entries()) {
    for (const { re, group } of patterns) {
      re.lastIndex = 0;

      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const key = match[group];

        if (isCamelCase(key)) {
          found.push({ key, line: index + 1, surface: `${match[1]}.*` });
        }
      }
    }
  }

  return found;
};

describe('REST handlers read snake_case wire keys', () => {
  const files = readdirSync(V1_DIR).filter((f) => {
    return f.endsWith('.ts');
  });

  test('every v1 handler file is scanned', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(files)('%s reads no camelCase wire key', (file) => {
    const source = readFileSync(join(V1_DIR, file), 'utf8');

    const violations = [
      ...collectWireKeys(source),
      ...collectAccessKeys(source),
    ];

    expect(
      violations.map((v) => {
        return `${file}:${v.line} reads \`${v.key}\` from ${v.surface} — no client sends that key`;
      })
    ).toEqual([]);
  });
});
