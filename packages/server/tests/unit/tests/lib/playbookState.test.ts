import { playbookMissingInputs as missingFor } from 'src/lib/playbookMissing';
import {
  playbookNodeStates as nodeStates,
  samePlaybookBasis,
} from 'src/lib/playbookState';

import {
  basis,
  type CaseSnapshot,
  collect,
  confirm,
  diamond,
  execute,
  manual,
  pricing,
  reads,
} from '../../fixtures/playbooks';

const statesOf = (
  ...args: Parameters<typeof nodeStates>
): Record<string, string> => {
  return Object.fromEntries(
    [...nodeStates(...args)].map(([key, view]) => {
      return [key, view.state];
    })
  );
};

const runnableOf = (...args: Parameters<typeof nodeStates>): string[] => {
  return [...nodeStates(...args)]
    .filter(([, view]) => {
      return view.runnable;
    })
    .map(([key]) => {
      return key;
    });
};

/** `a` collected `x` at revision 1 and every node downstream is done. */
const settledDiamond = (): CaseSnapshot => {
  return {
    a: {
      inputs: { x: { revision: 1, value: 'one' } },
      output: {
        revision: 2,
        value: { x: 'one' },
        basis: basis({ x: ['manual', 1] }),
      },
    },
    b: {
      output: {
        revision: 3,
        value: 'b1',
        basis: basis({ x: ['a.output.x', 2] }),
      },
    },
    c: {
      output: {
        revision: 4,
        value: 'c1',
        basis: basis({ x: ['a.output.x', 2] }),
      },
    },
    d: {
      output: {
        revision: 5,
        value: 'd1',
        basis: basis({ b: ['b.output', 3], c: ['c.output', 4] }),
      },
    },
  };
};

describe('nodeStates', () => {
  test('a fresh case is blocked on its manual inputs', () => {
    const views = nodeStates({ definition: pricing(), snapshot: {} });

    expect(views.get('client')).toMatchObject({
      state: 'blocked',
      runnable: false,
      missing: ['cnpj', 'annual_revenue'],
      blockedBy: [],
    });
    expect(views.get('tax_regime')).toMatchObject({
      state: 'blocked',
      missing: ['cnae'],
      blockedBy: ['client'],
    });
  });

  test('a node whose required inputs are set and current is ready', () => {
    const views = nodeStates({
      definition: pricing(),
      snapshot: {
        client: {
          inputs: {
            cnpj: { revision: 1, value: '12345678000199' },
            annual_revenue: { revision: 2, value: 3_000_000 },
          },
        },
      },
    });

    expect(views.get('client')).toMatchObject({
      state: 'ready',
      runnable: true,
      values: { cnpj: '12345678000199', annual_revenue: 3_000_000 },
      basis: basis({ cnpj: ['manual', 1], annual_revenue: ['manual', 2] }),
    });
    expect(views.get('tax_regime')?.state).toBe('blocked');
  });

  test('a node reads a field of a done node, and an input it read', () => {
    const views = nodeStates({
      definition: pricing(),
      snapshot: {
        client: {
          inputs: {
            cnpj: { revision: 1, value: '12345678000199' },
            annual_revenue: { revision: 2, value: 3_000_000 },
          },
          output: {
            revision: 3,
            value: { cnpj: '12345678000199', annual_revenue: 3_000_000 },
            basis: basis({
              cnpj: ['manual', 1],
              annual_revenue: ['manual', 2],
            }),
          },
        },
        tax_regime: {
          inputs: { cnae: { revision: 4, value: '6201501' } },
          output: {
            revision: 5,
            value: { value: 'presumido' },
            basis: basis({
              annual_revenue: ['client.output.annual_revenue', 3],
              cnae: ['manual', 4],
            }),
          },
        },
      },
    });

    expect(views.get('tax_regime')?.state).toBe('done');
    expect(views.get('price')).toMatchObject({
      state: 'ready',
      runnable: true,
      values: { regime: 'presumido', cnpj: '12345678000199' },
      basis: basis({
        regime: ['tax_regime.output.value', 5],
        cnpj: ['client.input.cnpj', 1],
      }),
    });
  });

  test.each([
    ['output.bands.1', 20],
    ['output.bands.9', undefined],
    ['output.regime.deeper', undefined],
  ])('reading %s gives %j', (field, value) => {
    const views = nodeStates({
      definition: {
        nodes: [execute('a', []), execute('b', [reads('v', 'a', field)])],
      },
      snapshot: {
        a: {
          output: {
            revision: 1,
            value: { regime: 'simples', bands: [10, 20] },
            basis: {},
          },
        },
      },
    });

    expect(views.get('b')?.values.v).toEqual(value);
  });

  test('a settled case is done everywhere and runs nothing', () => {
    expect(
      statesOf({ definition: diamond(), snapshot: settledDiamond() })
    ).toEqual({ a: 'done', b: 'done', c: 'done', d: 'done' });
    expect(
      runnableOf({ definition: diamond(), snapshot: settledDiamond() })
    ).toEqual([]);
  });

  describe('the cascade', () => {
    test('a changed input makes every reader stale and runs only its node', () => {
      const snapshot = settledDiamond();

      snapshot.a.inputs = { x: { revision: 6, value: 'two' } };

      expect(statesOf({ definition: diamond(), snapshot })).toEqual({
        a: 'stale',
        b: 'stale',
        c: 'stale',
        d: 'stale',
      });
      expect(runnableOf({ definition: diamond(), snapshot })).toEqual(['a']);
    });

    test('a join under two changed nodes runs once, after both', () => {
      const snapshot = settledDiamond();

      snapshot.a = {
        inputs: { x: { revision: 6, value: 'two' } },
        output: {
          revision: 7,
          value: { x: 'two' },
          basis: basis({ x: ['manual', 6] }),
        },
      };

      expect(runnableOf({ definition: diamond(), snapshot })).toEqual([
        'b',
        'c',
      ]);

      snapshot.b.output = {
        revision: 8,
        value: 'b2',
        basis: basis({ x: ['a.output.x', 7] }),
      };

      expect(runnableOf({ definition: diamond(), snapshot })).toEqual(['c']);
      expect(
        nodeStates({ definition: diamond(), snapshot }).get('d')
      ).toMatchObject({ state: 'stale', blockedBy: ['c'] });

      snapshot.c.output = {
        revision: 9,
        value: 'c2',
        basis: basis({ x: ['a.output.x', 7] }),
      };

      expect(runnableOf({ definition: diamond(), snapshot })).toEqual(['d']);
    });

    test('an equal value writes no revision, so nothing downstream runs', () => {
      const snapshot = settledDiamond();

      snapshot.a.inputs = { x: { revision: 6, value: 'one' } };
      // `a` ran on the new revision and produced what it had.
      snapshot.a.output = {
        revision: 2,
        value: { x: 'one' },
        basis: basis({ x: ['manual', 6] }),
      };

      expect(statesOf({ definition: diamond(), snapshot })).toEqual({
        a: 'done',
        b: 'done',
        c: 'done',
        d: 'done',
      });
    });

    test('an execution in flight is running and holds its readers', () => {
      const snapshot = settledDiamond();

      snapshot.a.inputs = { x: { revision: 6, value: 'two' } };
      snapshot.a.execution = {
        status: 'running',
        basis: basis({ x: ['manual', 6] }),
      };

      const views = nodeStates({ definition: diamond(), snapshot });

      expect(views.get('a')).toMatchObject({
        state: 'running',
        runnable: false,
      });
      expect(views.get('b')).toMatchObject({
        state: 'stale',
        blockedBy: ['a'],
      });
    });

    test('an execution waiting on a run it started is waiting and holds its readers', () => {
      const snapshot = settledDiamond();

      snapshot.a.inputs = { x: { revision: 6, value: 'two' } };
      snapshot.a.execution = {
        status: 'running',
        basis: basis({ x: ['manual', 6] }),
        run: { type: 'task', id: 'task_1' },
      };

      const views = nodeStates({ definition: diamond(), snapshot });

      expect(views.get('a')).toMatchObject({
        state: 'waiting',
        runnable: false,
        settling: true,
      });
      expect(views.get('b')).toMatchObject({
        state: 'stale',
        blockedBy: ['a'],
      });
    });

    test('a result read on an outdated basis is superseded', () => {
      const snapshot = settledDiamond();

      snapshot.a.inputs = { x: { revision: 8, value: 'three' } };

      const current = nodeStates({ definition: diamond(), snapshot }).get('a');

      expect(
        samePlaybookBasis({
          left: basis({ x: ['manual', 6] }),
          right: current?.basis ?? {},
        })
      ).toBe(false);
      expect(
        samePlaybookBasis({
          left: basis({ x: ['manual', 8] }),
          right: current?.basis ?? {},
        })
      ).toBe(true);
    });

    test('a failure on the current basis is failed and does not retry', () => {
      const snapshot = settledDiamond();

      snapshot.a.inputs = { x: { revision: 6, value: 'two' } };
      snapshot.a.execution = {
        status: 'failed',
        basis: basis({ x: ['manual', 6] }),
      };

      expect(statesOf({ definition: diamond(), snapshot }).a).toBe('failed');
      expect(runnableOf({ definition: diamond(), snapshot })).toEqual([]);

      snapshot.a.inputs = { x: { revision: 7, value: 'three' } };

      expect(runnableOf({ definition: diamond(), snapshot })).toEqual(['a']);
    });
  });

  describe('confirm nodes', () => {
    const definition = {
      nodes: [
        collect('a', [manual('x')]),
        confirm('ok', [reads('x', 'a', 'output.x')]),
        execute('after', [reads('ok', 'ok', 'output')]),
      ],
    };

    const collected = (revision: number): CaseSnapshot => {
      return {
        a: {
          inputs: { x: { revision, value: `v${revision}` } },
          output: {
            revision: revision + 1,
            value: { x: `v${revision}` },
            basis: basis({ x: ['manual', revision] }),
          },
        },
      };
    };

    test('wait for a person, and the engine never runs them', () => {
      const views = nodeStates({ definition, snapshot: collected(1) });

      expect(views.get('ok')).toMatchObject({
        state: 'ready',
        runnable: false,
      });
      expect(views.get('after')?.state).toBe('blocked');
    });

    test('an approval is their output', () => {
      const snapshot = collected(1);

      snapshot.ok = {
        output: {
          revision: 3,
          value: { x: 'v1' },
          basis: basis({ x: ['a.output.x', 2] }),
        },
      };

      expect(statesOf({ definition, snapshot })).toMatchObject({
        ok: 'done',
        after: 'ready',
      });
    });

    test('changed inputs hold everything downstream until confirmed again', () => {
      const snapshot = collected(4);

      snapshot.ok = {
        output: {
          revision: 3,
          value: { x: 'v1' },
          basis: basis({ x: ['a.output.x', 2] }),
        },
      };
      snapshot.after = {
        output: {
          revision: 6,
          value: 'went ahead',
          basis: basis({ ok: ['ok.output', 3] }),
        },
      };

      const views = nodeStates({ definition, snapshot });

      expect(views.get('ok')).toMatchObject({
        state: 'stale',
        runnable: false,
      });
      expect(views.get('after')).toMatchObject({
        state: 'stale',
        runnable: false,
        blockedBy: ['ok'],
      });
    });

    test('a rejection on the current basis blocks everything downstream', () => {
      const snapshot = collected(1);

      snapshot.ok = { rejection: { basis: basis({ x: ['a.output.x', 2] }) } };

      expect(statesOf({ definition, snapshot })).toMatchObject({
        ok: 'rejected',
        after: 'blocked',
      });
    });

    test('a rejection on an outdated basis waits for a person again', () => {
      const snapshot = collected(5);

      snapshot.ok = { rejection: { basis: basis({ x: ['a.output.x', 2] }) } };

      expect(statesOf({ definition, snapshot }).ok).toBe('ready');
    });
  });

  describe('optional inputs', () => {
    const definition = {
      nodes: [
        collect('hint', [manual('text')]),
        execute('a', [manual('x')]),
        execute('b', [
          reads('a', 'a', 'output'),
          reads('hint', 'hint', 'output.text', { required: false }),
        ]),
      ],
    };

    const aDone: CaseSnapshot = {
      a: {
        inputs: { x: { revision: 1, value: 'x' } },
        output: { revision: 2, value: 'A', basis: basis({ x: ['manual', 1] }) },
      },
    };

    test('read as unset while their node waits on a person', () => {
      expect(
        nodeStates({ definition, snapshot: aDone }).get('b')
      ).toMatchObject({
        state: 'ready',
        runnable: true,
        values: { a: 'A' },
        basis: basis({ a: ['a.output', 2], hint: ['hint.output.text', null] }),
      });
    });

    test('hold their reader while their node is about to produce a value', () => {
      const snapshot: CaseSnapshot = {
        ...aDone,
        hint: { inputs: { text: { revision: 3, value: 'be brief' } } },
      };

      expect(nodeStates({ definition, snapshot }).get('b')).toMatchObject({
        state: 'blocked',
        runnable: false,
        blockedBy: ['hint'],
      });
    });
  });

  test('a value its schema refuses reads as unset', () => {
    const views = nodeStates({
      definition: pricing(),
      snapshot: {
        tax_regime: { inputs: { cnae: { revision: 1, value: '62' } } },
      },
      conforms: ({ input, value }) => {
        return input.name !== 'cnae' || /^\d{7}$/.test(String(value));
      },
    });

    expect(views.get('tax_regime')?.missing).toEqual(['cnae']);
  });

  test('an input now reading another field makes its node stale', () => {
    const definition = {
      nodes: [
        collect('a', [manual('x'), manual('y')]),
        execute('b', [reads('v', 'a', 'output.y')]),
      ],
    };
    const snapshot = settledDiamond();

    snapshot.a = {
      inputs: {
        x: { revision: 1, value: 'one' },
        y: { revision: 6, value: 'why' },
      },
      output: {
        revision: 7,
        value: { x: 'one', y: 'why' },
        basis: basis({ x: ['manual', 1], y: ['manual', 6] }),
      },
    };
    snapshot.b = {
      output: {
        revision: 8,
        value: 'b',
        basis: basis({ v: ['a.output.x', 7] }),
      },
    };

    expect(nodeStates({ definition, snapshot }).get('b')).toMatchObject({
      state: 'stale',
      runnable: true,
    });
  });
});

describe('missingFor', () => {
  test('lists the open manual inputs upstream of a node, in waves', () => {
    expect(
      missingFor({ definition: pricing(), snapshot: {}, node: 'price' })
    ).toEqual([
      [
        { node: 'client', input: 'cnpj', schema: { type: 'string' } },
        { node: 'client', input: 'annual_revenue', schema: { type: 'number' } },
      ],
      [
        {
          node: 'tax_regime',
          input: 'cnae',
          schema: { type: 'string', pattern: '^\\d{7}$' },
        },
      ],
    ]);
  });

  test('drops what is filled and what is not upstream', () => {
    const definition = {
      nodes: [
        ...pricing().nodes,
        collect('unrelated', [manual('z', { description: 'Not needed' })]),
        collect('contact', [manual('email', { description: 'Who signs' })]),
        execute('sign', [
          reads('review', 'review', 'output'),
          reads('email', 'contact', 'output.email'),
        ]),
      ],
    };

    expect(
      missingFor({
        definition,
        snapshot: {
          client: {
            inputs: {
              cnpj: { revision: 1, value: '1' },
              annual_revenue: { revision: 2, value: 10 },
            },
          },
        },
        node: 'sign',
      })
    ).toEqual([
      [
        {
          node: 'contact',
          input: 'email',
          schema: { type: 'string' },
          description: 'Who signs',
        },
      ],
      [
        {
          node: 'tax_regime',
          input: 'cnae',
          schema: { type: 'string', pattern: '^\\d{7}$' },
        },
      ],
    ]);
  });
});
