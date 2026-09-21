import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A project's metadata schema is only worth what the least careful writer
 * honours: one module minting a `Document` row of its own would store metadata
 * nothing judged, and the corpus would hold rows that cannot be read as the
 * schema says they can.
 *
 * So every caller-facing write goes through `documents.ts`, where the gate is.
 * Static because the defect is an absent call: a module writing its own row
 * passes every test that does not happen to declare a schema first.
 */

const LIB_DIR = join(__dirname, '../../../../src/lib');

/** The gate each write path states its half of the question to. */
const GATES = [
  'assertCreatedDocumentMetadataValid',
  'assertUpdatedDocumentMetadataValid',
];

/**
 * The modules that may write a `documents` row.
 *
 * `documents.ts` owns the caller-facing create and update, and is where the
 * gate is applied. `documentIngestion.ts` mints the row that a file's
 * ingestion pipeline fills, which is why the second test holds it to writing
 * no `metadata`: a row created there carries none until a `PATCH` adds some,
 * and that `PATCH` is judged.
 */
const DOCUMENT_ROW_WRITERS = ['documentIngestion.ts', 'documents.ts'];

/** Blanks comments while preserving offsets, so prose is never a match. */
const code = (path: string): string => {
  return readFileSync(path, 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => {
      return match.replace(/[^\n]/g, ' ');
    }
  );
};

/** The argument text of one call, brace-counted so nested objects survive. */
const callArguments = (source: string, fn: string): string[] => {
  const calls: string[] = [];

  for (const match of source.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
    let depth = 0;
    const start = match.index + match[0].length - 1;

    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (char === '(' || char === '{' || char === '[') depth += 1;
      if (char === ')' || char === '}' || char === ']') depth -= 1;
      if (depth === 0) {
        calls.push(source.slice(start, i + 1));
        break;
      }
    }
  }

  return calls;
};

describe('document metadata contract', () => {
  test('only the document module and ingestion write a document row', () => {
    const writers = readdirSync(LIB_DIR, { recursive: true })
      .filter((entry): entry is string => {
        return typeof entry === 'string' && entry.endsWith('.ts');
      })
      .filter((entry) => {
        return /db\.Document\.create\(/.test(code(join(LIB_DIR, entry)));
      })
      .sort();

    expect(writers).toEqual(DOCUMENT_ROW_WRITERS);
  });

  test('the ingestion row carries no metadata', () => {
    const calls = callArguments(
      code(join(LIB_DIR, 'documentIngestion.ts')),
      'db.Document.create'
    );

    expect(calls).not.toEqual([]);
    expect(
      calls.filter((args) => {
        return args.includes('metadata');
      })
    ).toEqual([]);
  });

  test.each(GATES)('%s is applied in the document module', (gate) => {
    expect(code(join(LIB_DIR, 'documents.ts'))).toContain(`${gate}(`);
  });

  test('the gate lives in one module', () => {
    const owners = readdirSync(LIB_DIR)
      .filter((entry) => {
        if (!entry.endsWith('.ts')) return false;
        const source = code(join(LIB_DIR, entry));
        return GATES.some((gate) => {
          return new RegExp(`export const ${gate}\\b`).test(source);
        });
      })
      .sort();

    expect(owners).toEqual(['metadataSchemas.ts']);
  });
});
