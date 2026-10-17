import { playbookUpgradeDiff as upgradeDiff } from 'src/lib/playbookUpgrade';

import {
  collect,
  execute,
  manual,
  pricing,
  reads,
} from '../../fixtures/playbooks';

describe('upgradeDiff', () => {
  test('an identical definition changes nothing', () => {
    expect(upgradeDiff({ from: pricing(), to: pricing() })).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  test('a title or a description changes nothing', () => {
    const to = pricing();

    to.nodes[0] = { ...to.nodes[0]!, title: 'Client', description: 'Who' };

    expect(upgradeDiff({ from: pricing(), to }).changed).toEqual([]);
  });

  test('names added and removed nodes by id', () => {
    const to = {
      nodes: [
        ...pricing().nodes.filter((node) => {
          return node.id !== 'review';
        }),
        collect('contact', [manual('email')]),
      ],
    };

    expect(upgradeDiff({ from: pricing(), to })).toMatchObject({
      added: ['contact'],
      removed: ['review'],
    });
  });

  test('names each input whose source, schema or presence changed', () => {
    const to = pricing();

    to.nodes[1] = execute(
      'tax_regime',
      [
        reads('annual_revenue', 'client', 'output.cnpj'),
        manual('cnae', { schema: { type: 'string' } }),
        manual('state'),
      ],
      { executor: { type: 'decider', id: 'dcd_regime', input: {} } }
    );
    to.nodes[2] = execute('price', [
      reads('regime', 'tax_regime', 'output.value'),
    ]);

    expect(upgradeDiff({ from: pricing(), to }).changed).toEqual([
      {
        node_id: 'tax_regime',
        executor: false,
        inputs: [
          { name: 'annual_revenue', change: 'source' },
          { name: 'cnae', change: 'schema' },
          { name: 'state', change: 'added' },
        ],
      },
      {
        node_id: 'price',
        executor: false,
        inputs: [{ name: 'cnpj', change: 'removed' }],
      },
    ]);
  });

  test('an input becoming optional is a change', () => {
    const to = pricing();

    to.nodes[2] = execute('price', [
      reads('regime', 'tax_regime', 'output.value', { required: false }),
      reads('cnpj', 'client', 'input.cnpj'),
    ]);

    expect(upgradeDiff({ from: pricing(), to }).changed).toEqual([
      {
        node_id: 'price',
        executor: false,
        inputs: [{ name: 'regime', change: 'required' }],
      },
    ]);
  });

  test('reports an executor change, whatever its inputs did', () => {
    const to = pricing();

    to.nodes[2] = {
      ...to.nodes[2]!,
      executor: { type: 'agent', id: 'agt_other', input: {} },
    };

    expect(upgradeDiff({ from: pricing(), to }).changed).toEqual([
      { node_id: 'price', executor: true, inputs: [] },
    ]);
  });
});
