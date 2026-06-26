import {
  applyInputMapping,
  evaluateLogic,
  isLogic,
} from 'src/lib/jsonLogicMapping';

describe('jsonLogicMapping', () => {
  describe('isLogic', () => {
    test('returns true for a single-key object', () => {
      expect(isLogic({ var: 'name' })).toBe(true);
    });

    test('returns true for a logic operator object', () => {
      expect(isLogic({ '>': [1, 0] })).toBe(true);
    });

    test('returns false for a multi-key object', () => {
      expect(isLogic({ a: 1, b: 2 })).toBe(false);
    });

    test('returns false for an empty object', () => {
      expect(isLogic({})).toBe(false);
    });

    test('returns false for null', () => {
      expect(isLogic(null)).toBe(false);
    });

    test('returns false for an array', () => {
      expect(isLogic([{ var: 'x' }])).toBe(false);
    });

    test('returns false for a string', () => {
      expect(isLogic('hello')).toBe(false);
    });

    test('returns false for a number', () => {
      expect(isLogic(42)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(isLogic(undefined)).toBe(false);
    });
  });

  describe('evaluateLogic', () => {
    test('evaluates a var expression against the context', () => {
      expect(evaluateLogic({ var: 'name' }, { name: 'Alice' })).toBe('Alice');
    });

    test('returns null for a missing var path', () => {
      expect(evaluateLogic({ var: 'missing' }, {})).toBeNull();
    });

    test('passes through a string literal unchanged', () => {
      expect(evaluateLogic('hello', { name: 'Alice' })).toBe('hello');
    });

    test('passes through a number literal unchanged', () => {
      expect(evaluateLogic(42, {})).toBe(42);
    });

    test('passes through a multi-key object unchanged', () => {
      const obj = { a: 1, b: 2 };
      expect(evaluateLogic(obj, {})).toBe(obj);
    });

    test('passes through an array unchanged', () => {
      const arr = [1, 2, 3];
      expect(evaluateLogic(arr, {})).toBe(arr);
    });

    test('passes through null unchanged', () => {
      expect(evaluateLogic(null, {})).toBeNull();
    });

    test('evaluates an arithmetic expression', () => {
      expect(evaluateLogic({ '+': [1, 2] }, {})).toBe(3);
    });
  });

  describe('applyInputMapping', () => {
    test('returns empty object when inputMapping is undefined', () => {
      expect(applyInputMapping(undefined, {})).toEqual({});
    });

    test('resolves var expressions against context', () => {
      const result = applyInputMapping(
        { agentId: { var: 'agent' }, projectId: { var: 'project' } },
        { agent: 'agt_1', project: 'prj_1' }
      );
      expect(result).toEqual({ agentId: 'agt_1', projectId: 'prj_1' });
    });

    test('passes through literal values unchanged', () => {
      const result = applyInputMapping(
        { name: 'fixed', count: 5 },
        { anything: 'ignored' }
      );
      expect(result).toEqual({ name: 'fixed', count: 5 });
    });

    test('mixes literals and var expressions in the same mapping', () => {
      const result = applyInputMapping(
        { literal: 'hello', dynamic: { var: 'x' } },
        { x: 'world' }
      );
      expect(result).toEqual({ literal: 'hello', dynamic: 'world' });
    });

    test('returns empty object for an empty inputMapping', () => {
      expect(applyInputMapping({}, { x: 1 })).toEqual({});
    });
  });
});
