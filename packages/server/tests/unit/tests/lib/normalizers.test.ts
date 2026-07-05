import { coalesce } from 'src/lib/resource-inputs/normalizers';

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
