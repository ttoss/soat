import type { PlaybookDefinition } from 'src/lib/playbookDefinition';
import { topologicalWaves } from 'src/lib/playbookGraph';
import { validatePlaybookDefinition } from 'src/lib/playbookValidation';

import {
  collect,
  diamond,
  execute,
  manual,
  pricing,
  reads,
} from '../../fixtures/playbooks';

const validate = (definition: PlaybookDefinition) => {
  return validatePlaybookDefinition({ definition });
};

describe('validatePlaybookDefinition', () => {
  test('a well-formed playbook has no problems', () => {
    expect(validate(pricing())).toEqual([]);
  });

  test('a source naming no node is refused', () => {
    const problems = validate({
      nodes: [execute('price', [reads('regime', 'tax_regime', 'output')])],
    });

    expect(problems).toEqual([
      { code: 'missing_node', node_id: 'price', input: 'regime' },
    ]);
  });

  test('a cycle is refused, naming every node in it', () => {
    const problems = validate({
      nodes: [
        execute('a', [reads('b', 'b', 'output')]),
        execute('b', [reads('a', 'a', 'output')]),
        execute('c', [reads('a', 'a', 'output')]),
      ],
    });

    expect(problems).toEqual([{ code: 'cycle', nodes: ['a', 'b'] }]);
  });

  test('each cycle is named apart, in definition order', () => {
    expect(
      validate({
        nodes: [
          execute('c', [reads('d', 'd', 'output')]),
          execute('d', [reads('c', 'c', 'output')]),
          execute('a', [reads('b', 'b', 'output')]),
          execute('b', [reads('a', 'a', 'output')]),
        ],
      })
    ).toEqual([
      { code: 'cycle', nodes: ['c', 'd'] },
      { code: 'cycle', nodes: ['a', 'b'] },
    ]);
  });

  test('a node reading itself is a cycle', () => {
    expect(
      validate({
        nodes: [execute('a', [reads('a', 'a', 'output')])],
      })
    ).toEqual([{ code: 'cycle', nodes: ['a'] }]);
  });

  test('a node id or an input name used twice is refused', () => {
    expect(
      validate({
        nodes: [
          collect('a', [manual('x'), manual('x')]),
          collect('a', [manual('y')]),
        ],
      })
    ).toEqual([
      { code: 'duplicate_node', node_id: 'a' },
      { code: 'duplicate_input', node_id: 'a', input: 'x' },
    ]);
  });

  test.each([
    ['a field outside output and input', 'value'],
    ['an input the node does not declare', 'input.nope'],
    // A collect node's output is its inputs, so its fields are known.
    ['a collect output field it does not collect', 'output.nope'],
  ])('%s is refused', (_, field) => {
    expect(
      validate({
        nodes: [
          collect('a', [manual('x')]),
          execute('b', [reads('x', 'a', field)]),
        ],
      })
    ).toEqual([{ code: 'unknown_field', node_id: 'b', input: 'x' }]);
  });

  test('an execute output may be read at any path', () => {
    expect(
      validate({
        nodes: [
          execute('a', []),
          execute('b', [reads('x', 'a', 'output.deep.path')]),
        ],
      })
    ).toEqual([]);
  });

  test('only execute nodes carry an executor, and they must', () => {
    expect(
      validate({
        nodes: [
          { ...collect('a', []), executor: { type: 'tool', id: 'tool_1' } },
          execute('b', [], { executor: undefined }),
        ],
      })
    ).toEqual([
      { code: 'executor_forbidden', node_id: 'a' },
      { code: 'executor_required', node_id: 'b' },
    ]);
  });

  test('only final nodes carry transformations', () => {
    expect(
      validate({
        nodes: [
          execute('a', [], {
            transformations: [{ name: 'p', format: 'pdf', tool: 'tool_1' }],
          }),
        ],
      })
    ).toEqual([{ code: 'transformations_not_final', node_id: 'a' }]);
  });
});

describe('topologicalWaves', () => {
  test('each wave reads only the waves before it', () => {
    expect(topologicalWaves({ definition: diamond() })).toEqual({
      waves: [['a'], ['b', 'c'], ['d']],
      cycles: [],
    });
  });

  test('a node downstream of a cycle is left out of every wave', () => {
    expect(
      topologicalWaves({
        definition: {
          nodes: [
            execute('a', [reads('b', 'b', 'output')]),
            execute('b', [reads('a', 'a', 'output')]),
            execute('c', [reads('a', 'a', 'output')]),
            execute('d', []),
          ],
        },
      })
    ).toEqual({ waves: [['d']], cycles: [['a', 'b']] });
  });
});
