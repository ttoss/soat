import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MEMORY_ASSERTION_MECHANISMS,
  MEMORY_ASSERTION_OUTCOMES,
} from '@soat/postgresdb';
import { load } from 'js-yaml';

// Pins the assertion vocabularies to every enum the specs publish for them: the
// `MemoryAssertion` read shape and the store ledger's filters. The route reads
// both filters through `readEnum` over these constants, so a spec enum narrower
// than a constant still answers `200` on REST while the `/mcp` tools, which
// validate arguments against the spec, and the generated SDK refuse the value.
//
// A `lib/` test per the keep-list rule: through an entry point each value is one
// call, so a drift shows only for the value a test thought to send.

const OPENAPI_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

type EnumSchema = { enum?: string[] };

type Spec = {
  paths?: Record<
    string,
    Record<
      string,
      { parameters?: { name?: string; in?: string; schema?: EnumSchema }[] }
    >
  >;
  components?: {
    schemas?: Record<string, { properties?: Record<string, EnumSchema> }>;
  };
};

const readSpec = (args: { file: string }): Spec => {
  return load(
    fs.readFileSync(path.join(OPENAPI_DIR, args.file), 'utf-8')
  ) as Spec;
};

const assertionProperties =
  readSpec({ file: 'memory-assertions.yaml' }).components?.schemas
    ?.MemoryAssertion?.properties ?? {};

const ledgerParameters =
  readSpec({ file: 'memory-stores.yaml' }).paths?.[
    '/api/v1/memory-stores/{memory_store_id}/assertions'
  ]?.get?.parameters ?? [];

const ledgerFilterEnum = (args: { name: string }) => {
  return ledgerParameters.find((parameter) => {
    return parameter.in === 'query' && parameter.name === args.name;
  })?.schema?.enum;
};

const VOCABULARIES = [
  { field: 'mechanism', values: MEMORY_ASSERTION_MECHANISMS },
  { field: 'outcome', values: MEMORY_ASSERTION_OUTCOMES },
];

describe('memory assertion vocabulary contract', () => {
  test.each(VOCABULARIES)(
    'MemoryAssertion.$field publishes exactly the stored values',
    ({ field, values }) => {
      expect([...(assertionProperties[field]?.enum ?? [])].sort()).toEqual(
        [...values].sort()
      );
    }
  );

  test.each(VOCABULARIES)(
    'the store ledger $field filter accepts exactly the stored values',
    ({ field, values }) => {
      expect([...(ledgerFilterEnum({ name: field }) ?? [])].sort()).toEqual(
        [...values].sort()
      );
    }
  );
});
