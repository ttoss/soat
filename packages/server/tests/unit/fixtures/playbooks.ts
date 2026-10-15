import type {
  PlaybookDefinition,
  PlaybookInput,
  PlaybookNode,
} from 'src/lib/playbookDefinition';
import type {
  PlaybookBasis as Basis,
  PlaybookCaseSnapshot as CaseSnapshot,
} from 'src/lib/playbookState';

export const manual = (
  name: string,
  overrides: Partial<PlaybookInput> = {}
): PlaybookInput => {
  return {
    name,
    schema: { type: 'string' },
    required: true,
    source: 'manual',
    ...overrides,
  };
};

export const reads = (
  name: string,
  node: string,
  field: string,
  overrides: Partial<PlaybookInput> = {}
): PlaybookInput => {
  return {
    name,
    schema: {},
    required: true,
    source: { node, field },
    ...overrides,
  };
};

export const collect = (key: string, inputs: PlaybookInput[]): PlaybookNode => {
  return { key, title: key, kind: 'collect', final: false, inputs };
};

export const execute = (
  key: string,
  inputs: PlaybookInput[],
  overrides: Partial<PlaybookNode> = {}
): PlaybookNode => {
  return {
    key,
    title: key,
    kind: 'execute',
    final: false,
    inputs,
    executor: { type: 'agent', id: `agt_${key}`, input: {} },
    ...overrides,
  };
};

export const confirm = (key: string, inputs: PlaybookInput[]): PlaybookNode => {
  return { key, title: key, kind: 'confirm', final: false, inputs };
};

/**
 * Pricing a client: the CNPJ and the revenue are collected, the regime is
 * decided from the revenue, the price comes from the regime, and a person
 * confirms it.
 */
export const pricing = (): PlaybookDefinition => {
  return {
    nodes: [
      collect('client', [
        manual('cnpj'),
        manual('annual_revenue', { schema: { type: 'number' } }),
      ]),
      execute(
        'tax_regime',
        [
          reads('annual_revenue', 'client', 'output.annual_revenue'),
          manual('cnae', { schema: { type: 'string', pattern: '^\\d{7}$' } }),
        ],
        { executor: { type: 'decider', id: 'dcd_regime', input: {} } }
      ),
      execute('price', [
        reads('regime', 'tax_regime', 'output.value'),
        reads('cnpj', 'client', 'input.cnpj'),
      ]),
      {
        ...confirm('review', [reads('price', 'price', 'output')]),
        final: true,
        transformations: [
          { name: 'proposal', format: 'pdf', tool: 'tool_pdf' },
        ],
      },
    ],
  };
};

/**
 * `d` joins `b` and `c`, which both read `a`: one change to `a` reaches `d`
 * along two paths.
 */
export const diamond = (): PlaybookDefinition => {
  return {
    nodes: [
      collect('a', [manual('x')]),
      execute('b', [reads('x', 'a', 'output.x')]),
      execute('c', [reads('x', 'a', 'output.x')]),
      execute('d', [reads('b', 'b', 'output'), reads('c', 'c', 'output')]),
    ],
  };
};

export const basis = (
  reads: Record<string, [string, number | null]>
): Basis => {
  return Object.fromEntries(
    Object.entries(reads).map(([name, [from, revision]]) => {
      return [name, { from, revision }];
    })
  );
};

export type { CaseSnapshot };
