import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Solution } from '../src/data/solutions';
import { orderSolutions, PINNED_SLUG, solutions } from '../src/data/solutions';

const asSolution = (name: string, slug: string) => {
  return { name, slug } as Solution;
};

test('the pinned solution sorts first, the rest alphabetically by name', () => {
  const ordered = orderSolutions([
    asSolution('Zeta', 'zeta'),
    asSolution('LangChain', 'langchain'),
    asSolution('SOAT', PINNED_SLUG),
    asSolution('Alpha', 'alpha'),
  ]);

  assert.deepEqual(
    ordered.map((solution) => {
      return solution.name;
    }),
    ['SOAT', 'Alpha', 'LangChain', 'Zeta']
  );
});

test('ordering is alphabetical when the pinned solution is filtered out', () => {
  const ordered = orderSolutions([
    asSolution('Zeta', 'zeta'),
    asSolution('Alpha', 'alpha'),
  ]);

  assert.deepEqual(
    ordered.map((solution) => {
      return solution.name;
    }),
    ['Alpha', 'Zeta']
  );
});

test('ordering does not mutate the input array', () => {
  const input = [asSolution('Zeta', 'zeta'), asSolution('Alpha', 'alpha')];
  orderSolutions(input);
  assert.equal(input[0].name, 'Zeta');
});

test('the real dataset lists SOAT first and the rest alphabetically', () => {
  const ordered = orderSolutions(solutions);
  assert.equal(ordered[0].slug, PINNED_SLUG);

  const rest = ordered.slice(1).map((solution) => {
    return solution.name;
  });
  assert.deepEqual(
    rest,
    [...rest].sort((a, b) => {
      return a.localeCompare(b);
    })
  );
});
