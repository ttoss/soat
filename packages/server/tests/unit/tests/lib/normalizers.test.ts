import {
  camelToSnakeKey,
  coalesce,
  convertKeys,
  convertKeysDeep,
  isPlainObject,
  normalizePropertyKeys,
  snakeToCamelKey,
} from 'src/lib/resource-inputs/normalizers';

// `coalesce` normalizes a formation property that may arrive under either
// its camelCase (REST/case-transform) or snake_case (stored template) key.
describe('coalesce', () => {
  test('uses the camelValue when it is defined', () => {
    expect(
      coalesce('camel', 'snake', (v) => {
        return v;
      })
    ).toBe('camel');
  });

  test('falls back to the snakeValue when camelValue is undefined', () => {
    expect(
      coalesce(undefined, 'snake', (v) => {
        return v;
      })
    ).toBe('snake');
  });

  test('applies the mapper to the resolved value', () => {
    expect(coalesce(undefined, '5', Number)).toBe(5);
  });
});

describe('camelToSnakeKey / snakeToCamelKey', () => {
  test('camelToSnakeKey converts each capital to _lower', () => {
    expect(camelToSnakeKey('aiProviderId')).toBe('ai_provider_id');
    expect(camelToSnakeKey('already_snake')).toBe('already_snake');
  });

  test('snakeToCamelKey converts _lower back to camelCase', () => {
    expect(snakeToCamelKey('ai_provider_id')).toBe('aiProviderId');
    expect(snakeToCamelKey('alreadyCamel')).toBe('alreadyCamel');
  });

  test('the two are inverse for a snake_case key', () => {
    expect(camelToSnakeKey(snakeToCamelKey('write_memory_id'))).toBe(
      'write_memory_id'
    );
  });
});

describe('isPlainObject', () => {
  test('accepts object literals and null-proto bags', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  test('rejects null, arrays, and class instances', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject('str')).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe('convertKeys (shallow)', () => {
  test('rewrites only top-level keys, leaving nested objects verbatim', () => {
    const result = convertKeys(
      { aiProviderId: 'aip_1', nested: { keepMe: 1 } },
      camelToSnakeKey
    );
    expect(result).toEqual({
      ai_provider_id: 'aip_1',
      // nested value bag is left untouched by the shallow transform
      nested: { keepMe: 1 },
    });
  });
});

describe('convertKeysDeep (recursive)', () => {
  test('rewrites keys at every depth, including inside arrays', () => {
    const result = convertKeysDeep(
      {
        writeMemoryId: 'mem_1',
        extraction: { aiProviderId: 'aip_1' },
        items: [{ someKey: 'v' }],
      },
      camelToSnakeKey
    );
    expect(result).toEqual({
      write_memory_id: 'mem_1',
      extraction: { ai_provider_id: 'aip_1' },
      items: [{ some_key: 'v' }],
    });
  });

  test('leaves leaf values (including strings with underscores) untouched', () => {
    const result = convertKeysDeep(
      { memoryIds: ['mem_a', 'mem_b'], count: 3, flag: true },
      camelToSnakeKey
    );
    expect(result).toEqual({
      memory_ids: ['mem_a', 'mem_b'],
      count: 3,
      flag: true,
    });
  });

  test('returns non-object primitives unchanged', () => {
    expect(convertKeysDeep('x', camelToSnakeKey)).toBe('x');
    expect(convertKeysDeep(42, camelToSnakeKey)).toBe(42);
    expect(convertKeysDeep(null, camelToSnakeKey)).toBeNull();
  });
});

describe('normalizePropertyKeys', () => {
  test('snake-cases top-level template keys, leaving nested bags verbatim', () => {
    expect(
      normalizePropertyKeys({
        aiProviderId: 'aip_1',
        outputSchema: { camelInside: 1 },
      })
    ).toEqual({
      ai_provider_id: 'aip_1',
      // a nested JSON-Schema/config bag must round-trip verbatim (shallow)
      output_schema: { camelInside: 1 },
    });
  });

  test('is idempotent on already-snake_case keys', () => {
    const snake = { ai_provider_id: 'aip_1', max_steps: 3 };
    expect(normalizePropertyKeys(snake)).toEqual(snake);
  });
});
