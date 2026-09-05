import { DomainError } from 'src/errors';
import {
  asSqlRow,
  readSqlCount,
  readSqlDecimal,
  readSqlNullableText,
  readSqlText,
} from 'src/lib/sqlRow';

/**
 * A pure `lib/` test: these readers exist so a raw `sequelize.query` result is
 * narrowed a column at a time instead of cast wholesale, and their whole point
 * is the branch that throws. Driving that branch through a real query would
 * mean writing a deliberately wrong one — the failure they guard is a query and
 * its reader drifting apart, which no passing query can reproduce.
 */
describe('asSqlRow', () => {
  test('copies an object row into a plain record', () => {
    expect(asSqlRow({ total: 3 })).toEqual({ total: 3 });
  });

  test.each([
    ['a scalar', 7],
    ['null', null],
    ['an array', [1, 2]],
  ])('throws on %s', (_label, row) => {
    expect(() => {
      return asSqlRow(row);
    }).toThrow(DomainError);
  });
});

describe('readSqlCount', () => {
  // `bigint` reaches the driver as a string unless a parser is installed, so a
  // COUNT has to read the same either way.
  test.each([
    ['a parsed number', 4, 4],
    ['an unparsed bigint string', '250000', 250_000],
    ['zero', '0', 0],
  ])('reads %s', (_label, value, expected) => {
    expect(readSqlCount({ n: value }, 'n')).toBe(expected);
  });

  test.each([
    ['a missing column', {}],
    ['null', { n: null }],
    ['non-numeric text', { n: 'many' }],
    ['a non-finite number', { n: Number.NaN }],
  ])('throws on %s', (_label, row) => {
    expect(() => {
      return readSqlCount(row, 'n');
    }).toThrow(DomainError);
  });

  test('names the column it could not read', () => {
    expect(() => {
      return readSqlCount({}, 'event_count');
    }).toThrow(/event_count/);
  });
});

describe('readSqlDecimal', () => {
  // A DECIMAL stays a string so no precision is lost before it is summed.
  test('keeps the string Postgres returned', () => {
    expect(readSqlDecimal({ c: '1.0000000001' }, 'c')).toBe('1.0000000001');
  });

  // Null from a SUM means nothing was summed — not zero, which would report an
  // unpriced bucket as free.
  test.each([
    ['null', { c: null }],
    ['a missing column', {}],
  ])('reads %s as null', (_label, row) => {
    expect(readSqlDecimal(row, 'c')).toBeNull();
  });

  test('accepts a number the driver already parsed', () => {
    expect(readSqlDecimal({ c: 1.5 }, 'c')).toBe('1.5');
  });

  test('throws on a value that is neither', () => {
    expect(() => {
      return readSqlDecimal({ c: { sum: 1 } }, 'c');
    }).toThrow(DomainError);
  });
});

describe('readSqlNullableText', () => {
  test('reads text', () => {
    expect(readSqlNullableText({ k: 'run_abc' }, 'k')).toBe('run_abc');
  });

  // A null key is a real bucket — work with no run or actor behind it.
  test.each([
    ['null', { k: null }],
    ['a missing column', {}],
  ])('reads %s as null', (_label, row) => {
    expect(readSqlNullableText(row, 'k')).toBeNull();
  });

  test('throws on a non-text value', () => {
    expect(() => {
      return readSqlNullableText({ k: 12 }, 'k');
    }).toThrow(DomainError);
  });
});

describe('readSqlText', () => {
  test('reads text', () => {
    expect(readSqlText({ k: 'input_tokens' }, 'k')).toBe('input_tokens');
  });

  test('throws when the column is null', () => {
    expect(() => {
      return readSqlText({ k: null }, 'k');
    }).toThrow(/unexpectedly null/);
  });
});
