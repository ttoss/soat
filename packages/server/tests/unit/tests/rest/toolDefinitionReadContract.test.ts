import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * A literal credential in a tool definition is masked as `{"no_echo": true}`
 * wherever the definition leaves the API (`lib/toolSecretRedaction.ts`). The
 * write-side schemas type every credential as `string`, so a response reaching
 * one cannot carry the mask: the carrier ships the literal or fails its own
 * contract. Every response that holds a tool definition declares a read schema.
 */

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');

const WRITE_SIDE_SCHEMAS = new Set([
  'tools.yaml#/components/schemas/CreateToolRequest',
  'tools.yaml#/components/schemas/UpdateToolRequest',
  'tools.yaml#/components/schemas/ToolExecuteConfig',
  'tools.yaml#/components/schemas/ToolMcpConfig',
  'agents.yaml#/components/schemas/ToolBinding',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const specs = new Map<string, unknown>(
  readdirSync(SPECS_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .map((file) => {
      return [file, load(readFileSync(join(SPECS_DIR, file), 'utf8'))];
    })
);

const resolvePointer = (args: { file: string; pointer: string }): unknown => {
  let node: unknown = specs.get(args.file);
  for (const segment of args.pointer.split('/').filter(Boolean)) {
    if (!isRecord(node)) return undefined;
    node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
};

/** Every write-side schema reachable from `node`, following `$ref`s across files. */
const reachedWriteSchemas = (args: {
  node: unknown;
  file: string;
  seen: Set<string>;
}): string[] => {
  const { node, file, seen } = args;
  if (Array.isArray(node)) {
    return node.flatMap((item) => {
      return reachedWriteSchemas({ node: item, file, seen });
    });
  }
  if (!isRecord(node)) return [];
  if (typeof node.$ref === 'string') {
    const [target, pointer = ''] = node.$ref.split('#');
    const targetFile = target ? target.replace(/^\.\//, '') : file;
    const key = `${targetFile}#${pointer}`;
    if (WRITE_SIDE_SCHEMAS.has(key)) return [key];
    if (seen.has(key)) return [];
    seen.add(key);
    return reachedWriteSchemas({
      node: resolvePointer({ file: targetFile, pointer }),
      file: targetFile,
      seen,
    });
  }
  return Object.values(node).flatMap((child) => {
    return reachedWriteSchemas({ node: child, file, seen });
  });
};

const responseFindings = (): string[] => {
  const findings: string[] = [];
  for (const [file, spec] of specs) {
    if (!isRecord(spec) || !isRecord(spec.paths)) continue;
    for (const [path, operations] of Object.entries(spec.paths)) {
      if (!isRecord(operations)) continue;
      for (const [method, operation] of Object.entries(operations)) {
        if (!isRecord(operation) || !isRecord(operation.responses)) continue;
        for (const schema of reachedWriteSchemas({
          node: operation.responses,
          file,
          seen: new Set(),
        })) {
          findings.push(`${file} ${method.toUpperCase()} ${path} → ${schema}`);
        }
      }
    }
  }
  return findings;
};

describe('tool definition read contract', () => {
  test('the walk sees a write-side schema behind a $ref', () => {
    expect(
      reachedWriteSchemas({
        node: { $ref: './tools.yaml#/components/schemas/CreateToolRequest' },
        file: 'agents.yaml',
        seen: new Set(),
      })
    ).toEqual(['tools.yaml#/components/schemas/CreateToolRequest']);
  });

  test('no response reaches a write-side tool schema', () => {
    expect(responseFindings()).toEqual([]);
  });
});
