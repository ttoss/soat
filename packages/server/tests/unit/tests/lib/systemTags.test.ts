import { DomainError } from 'src/errors';
import {
  assertNoSystemTagKeys,
  hasSystemTagFilter,
  isSystemTagKey,
  stripSystemTagKeys,
  SYSTEM_TAG_PREFIX,
} from 'src/lib/tags';

/**
 * `system.*` is the runtime's half of the tag bag: it says which conversation,
 * actor, agent and role a row came from, and a caller who could write it could
 * make one actor's turns answer to another's filter.
 */
describe('reserved system tag keys', () => {
  describe('isSystemTagKey', () => {
    test.each([
      ['system.actor', true],
      ['system.', true],
      ['systemic', false],
      ['System.actor', false],
      ['team', false],
    ])('%s → %s', (key, expected) => {
      expect(isSystemTagKey(key)).toBe(expected);
    });
  });

  describe('assertNoSystemTagKeys', () => {
    test('returns a caller bag unchanged', () => {
      const tags = { team: 'finance' };
      expect(assertNoSystemTagKeys(tags)).toBe(tags);
      expect(assertNoSystemTagKeys(undefined)).toBeUndefined();
      expect(assertNoSystemTagKeys(null)).toBeNull();
    });

    test('refuses a bag naming a reserved key', () => {
      expect(() => {
        return assertNoSystemTagKeys({ 'system.actor': 'actor_1' });
      }).toThrow(DomainError);
    });

    test('names the offending key, so the caller can find it', () => {
      expect(() => {
        return assertNoSystemTagKeys({ team: 'x', 'system.role': 'user' });
      }).toThrow(/system\.role/);
    });
  });

  describe('stripSystemTagKeys', () => {
    test('drops reserved keys and keeps the rest', () => {
      expect(
        stripSystemTagKeys({ team: 'finance', 'system.actor': 'actor_1' })
      ).toEqual({ team: 'finance' });
    });

    test('a bag of only reserved keys becomes empty, never null', () => {
      expect(stripSystemTagKeys({ 'system.actor': 'actor_1' })).toEqual({});
    });

    test('passes through nothing', () => {
      expect(stripSystemTagKeys(undefined)).toBeUndefined();
      expect(stripSystemTagKeys(null)).toBeNull();
    });
  });

  describe('hasSystemTagFilter', () => {
    test('true when a filter names a reserved key', () => {
      expect(hasSystemTagFilter({ 'system.actor': 'actor_1' })).toBe(true);
    });

    test('false for a caller-only filter, an empty bag or none', () => {
      expect(hasSystemTagFilter({ team: 'finance' })).toBe(false);
      expect(hasSystemTagFilter({})).toBe(false);
      expect(hasSystemTagFilter(undefined)).toBe(false);
    });
  });

  test('the prefix is a dot, so a `key:value` query pair still splits', () => {
    // `parseTagPairs` splits on the FIRST colon; a colon in the namespace would
    // make `?tags=system:actor:actor_1` parse as key `system`.
    expect(SYSTEM_TAG_PREFIX).toBe('system.');
    expect(SYSTEM_TAG_PREFIX).not.toContain(':');
  });
});
