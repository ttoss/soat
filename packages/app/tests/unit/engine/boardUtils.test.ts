import { describe, expect, test } from 'vitest';

import {
  boardColumnStates,
  boardResourceParam,
  findBoardCardsModule,
  groupCardsByState,
  isBoardShaped,
} from '@/engine/boardUtils';
import { parseModules } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';

const byTag = (tag: string): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => {
    return x.tag === tag;
  });
  if (!m) throw new Error(`${tag} module missing`);
  return m;
};

describe('boardColumnStates', () => {
  test('extracts named states with terminal flags, dropping unnamed entries', () => {
    const item: JsonObject = {
      id: 'wfl_1',
      states: [
        { name: 'todo', initial: true },
        { name: 'done', terminal: true },
        { initial: false }, // no name — dropped
      ],
    };
    expect(boardColumnStates(item)).toEqual([
      { name: 'todo', terminal: false },
      { name: 'done', terminal: true },
    ]);
  });

  test('returns an empty list when there are no states', () => {
    expect(boardColumnStates({ id: 'x' })).toEqual([]);
    expect(boardColumnStates({ id: 'x', states: 'nope' })).toEqual([]);
  });
});

describe('isBoardShaped', () => {
  test('true only when at least one named state exists', () => {
    expect(isBoardShaped({ states: [{ name: 'a' }] })).toBe(true);
    expect(isBoardShaped({ states: [] })).toBe(false);
    expect(isBoardShaped({ name: 'no states' })).toBe(false);
  });
});

describe('boardResourceParam', () => {
  test('returns the trailing path parameter of the detail route', () => {
    expect(boardResourceParam(byTag('Workflows'))).toBe('workflow_id');
  });

  test('returns null for a module without a detail route', () => {
    const noDetail: ModuleInfo = {
      tag: 'X',
      label: 'X',
      isProjectScoped: false,
    };
    expect(boardResourceParam(noDetail)).toBeNull();
  });
});

describe('findBoardCardsModule', () => {
  test('finds the companion collection filterable by this resource id', () => {
    const found = findBoardCardsModule(byTag('Workflows'), parseModules(testSpec));
    expect(found?.tag).toBe('Tasks');
  });

  test('returns null when no collection accepts the resource id filter', () => {
    // Agents' detail param is `agent_id`; no module lists by `agent_id` query.
    const found = findBoardCardsModule(byTag('Agents'), parseModules(testSpec));
    expect(found).toBeNull();
  });
});

describe('groupCardsByState', () => {
  const states = [
    { name: 'todo', terminal: false },
    { name: 'done', terminal: true },
  ];

  test('buckets cards into columns in declared state order', () => {
    const cards: JsonObject[] = [
      { id: 't1', state: 'todo' },
      { id: 't2', state: 'done' },
      { id: 't3', state: 'todo' },
    ];
    const { columns, extraColumns } = groupCardsByState({ cards, states });
    expect(columns.map((c) => c.state.name)).toEqual(['todo', 'done']);
    expect(columns[0].cards.map((c) => c.id)).toEqual(['t1', 't3']);
    expect(columns[1].cards.map((c) => c.id)).toEqual(['t2']);
    expect(extraColumns).toEqual([]);
  });

  test('collects cards in unknown states into extraColumns (nothing dropped)', () => {
    const cards: JsonObject[] = [
      { id: 't1', state: 'todo' },
      { id: 't2', state: 'archived' }, // not in the definition
    ];
    const { columns, extraColumns } = groupCardsByState({ cards, states });
    expect(columns[0].cards.map((c) => c.id)).toEqual(['t1']);
    expect(extraColumns).toHaveLength(1);
    expect(extraColumns[0].state.name).toBe('archived');
    expect(extraColumns[0].cards.map((c) => c.id)).toEqual(['t2']);
  });

  test('ignores cards with no state value', () => {
    const cards: JsonObject[] = [{ id: 't1' }, { id: 't2', state: '' }];
    const { columns, extraColumns } = groupCardsByState({ cards, states });
    expect(columns.every((c) => c.cards.length === 0)).toBe(true);
    expect(extraColumns).toEqual([]);
  });
});
