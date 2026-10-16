import { type Dag, topologicalWaves, upstreamOf } from 'src/lib/dag';

const dag = (sources: Record<string, string[]>): Dag => {
  return {
    keys: Object.keys(sources),
    sourcesOf: (key) => {
      return sources[key] ?? [];
    },
  };
};

describe('topologicalWaves', () => {
  test('levels keep declaration order within a wave', () => {
    expect(
      topologicalWaves(dag({ d: ['b', 'c'], c: ['a'], b: ['a'], a: [] }))
    ).toEqual({ waves: [['a'], ['c', 'b'], ['d']], cycles: [] });
  });

  test('a source that is not a key is no edge', () => {
    expect(topologicalWaves(dag({ a: ['ghost'], b: ['a'] }))).toEqual({
      waves: [['a'], ['b']],
      cycles: [],
    });
  });

  test('a repeated source counts once', () => {
    expect(topologicalWaves(dag({ a: [], b: ['a', 'a'] })).waves).toEqual([
      ['a'],
      ['b'],
    ]);
  });

  test('a repeated key keeps its first declaration', () => {
    expect(
      topologicalWaves({
        keys: ['a', 'b', 'a'],
        sourcesOf: (key) => {
          return key === 'b' ? ['a'] : [];
        },
      }).waves
    ).toEqual([['a'], ['b']]);
  });

  test('names each cycle, leaving what reads it out of every wave', () => {
    expect(
      topologicalWaves(
        dag({ a: [], s: ['s'], x: ['y'], y: ['x', 'a'], z: ['y'] })
      )
    ).toEqual({ waves: [['a']], cycles: [['s'], ['x', 'y']] });
  });

  test('an empty graph has no waves', () => {
    expect(topologicalWaves(dag({}))).toEqual({ waves: [], cycles: [] });
  });
});

describe('upstreamOf', () => {
  test('a key and everything it reads, transitively', () => {
    expect(
      upstreamOf({ dag: dag({ a: [], b: ['a'], c: ['b'], d: [] }), key: 'c' })
    ).toEqual(new Set(['c', 'b', 'a']));
  });

  test('terminates on a cycle', () => {
    expect(upstreamOf({ dag: dag({ x: ['y'], y: ['x'] }), key: 'x' })).toEqual(
      new Set(['x', 'y'])
    );
  });
});
