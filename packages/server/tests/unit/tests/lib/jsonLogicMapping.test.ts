import {
  applyInputMapping,
  applyOutputMapping,
  applyToolOutputMapping,
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

    test('returns false for a single-key object whose key is not a registered operator', () => {
      expect(isLogic({ nestedTitle: { var: 'input.title' } })).toBe(false);
    });

    test('returns true for the preserve operator', () => {
      expect(isLogic({ preserve: { var: 'x' } })).toBe(true);
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

    test('passes through a multi-key object unchanged (recursed, not the same reference)', () => {
      const obj = { a: 1, b: 2 };
      expect(evaluateLogic(obj, {})).toEqual(obj);
    });

    test('passes through an array unchanged (recursed, not the same reference)', () => {
      const arr = [1, 2, 3];
      expect(evaluateLogic(arr, {})).toEqual(arr);
    });

    test('passes through null unchanged', () => {
      expect(evaluateLogic(null, {})).toBeNull();
    });

    test('evaluates an arithmetic expression', () => {
      expect(evaluateLogic({ '+': [1, 2] }, {})).toBe(3);
    });

    test('recurses into a single-key object whose key is not a registered operator', () => {
      expect(
        evaluateLogic(
          { nestedTitle: { var: 'input.title' } },
          { input: { title: 'ok' } }
        )
      ).toEqual({ nestedTitle: 'ok' });
    });

    test('recurses into nested objects and arrays without mutating the original value', () => {
      const value = { a: { var: 'x' }, b: [{ var: 'y' }, 'literal'] };
      const result = evaluateLogic(value, { x: 1, y: 2 });
      expect(result).toEqual({ a: 1, b: [2, 'literal'] });
      expect(value).toEqual({ a: { var: 'x' }, b: [{ var: 'y' }, 'literal'] });
    });

    test('preserve returns its argument unevaluated', () => {
      expect(evaluateLogic({ preserve: { var: 'x' } }, { x: 1 })).toEqual({
        var: 'x',
      });
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

    test('resolves a var nested inside a multi-key object', () => {
      const result = applyInputMapping(
        {
          locale: 'pt-BR',
          data: {
            title: { var: 'input.title' },
            theme: { var: 'input.theme' },
          },
        },
        { input: { title: 'Hello', theme: 'dark' } }
      );
      expect(result).toEqual({
        locale: 'pt-BR',
        data: { title: 'Hello', theme: 'dark' },
      });
    });

    test('resolves a var nested inside a single-key non-operator object', () => {
      const result = applyInputMapping(
        { metadata: { nestedTitle: { var: 'input.title' } } },
        { input: { title: 'Nested Var Test 123' } }
      );
      expect(result).toEqual({
        metadata: { nestedTitle: 'Nested Var Test 123' },
      });
    });

    test('resolves vars nested inside arrays', () => {
      const result = applyInputMapping(
        { items: [{ var: 'input.a' }, { var: 'input.b' }] },
        { input: { a: 1, b: 2 } }
      );
      expect(result).toEqual({ items: [1, 2] });
    });

    test('resolves vars nested multiple levels deep', () => {
      const result = applyInputMapping(
        { a: { b: { c: { var: 'input.x' } } } },
        { input: { x: 'deep' } }
      );
      expect(result).toEqual({ a: { b: { c: 'deep' } } });
    });

    test('preserve returns a literal var-shaped object unevaluated at the top level', () => {
      const result = applyInputMapping(
        { raw: { preserve: { var: 'input.title' } } },
        { input: { title: 'ignored' } }
      );
      expect(result).toEqual({ raw: { var: 'input.title' } });
    });

    test('preserve returns a literal var-shaped object unevaluated when nested', () => {
      const result = applyInputMapping(
        { data: { raw: { preserve: { var: 'input.title' } } } },
        { input: { title: 'ignored' } }
      );
      expect(result).toEqual({ data: { raw: { var: 'input.title' } } });
    });
  });

  describe('applyOutputMapping', () => {
    test('returns empty object when outputMapping is undefined', () => {
      expect(applyOutputMapping(undefined, {})).toEqual({});
    });

    test('evaluates a bare top-level var expression to a scalar', () => {
      const result = applyOutputMapping(
        { var: 'steps.call.text' },
        { steps: { call: { text: 'Hi!' } } }
      );
      expect(result).toBe('Hi!');
    });

    test('evaluates a bare top-level cat expression to a scalar', () => {
      const result = applyOutputMapping(
        { cat: [{ var: 'steps.call.text' }] },
        { steps: { call: { text: 'Hi!' } } }
      );
      expect(result).toBe('Hi!');
    });

    test('still resolves a genuine object mapping with nested expressions', () => {
      const result = applyOutputMapping(
        { saved_id: { var: 'steps.persist.id' } },
        { steps: { persist: { id: 'doc_1' } } }
      );
      expect(result).toEqual({ saved_id: 'doc_1' });
    });

    test('mixes literals and var expressions in an object mapping', () => {
      const result = applyOutputMapping(
        { total: { var: 'steps.a.sum' }, echo: { var: 'input.n' } },
        { steps: { a: { sum: 100 } }, input: { n: 7 } }
      );
      expect(result).toEqual({ total: 100, echo: 7 });
    });
  });

  describe('applyToolOutputMapping', () => {
    test('returns the raw result unchanged when outputMapping is undefined', () => {
      const rawResult = { text: 'Hi!', language: 'en' };
      expect(applyToolOutputMapping(undefined, rawResult)).toBe(rawResult);
    });

    test('returns the raw result unchanged when outputMapping is null', () => {
      const rawResult = { text: 'Hi!' };
      expect(applyToolOutputMapping(null, rawResult)).toBe(rawResult);
    });

    test('extracts a bare scalar field from the raw result via a var expression', () => {
      const result = applyToolOutputMapping(
        { var: 'output.text' },
        { text: 'Hi!', language: 'en' }
      );
      expect(result).toBe('Hi!');
    });

    test('reshapes the raw result into an object mapping', () => {
      const result = applyToolOutputMapping(
        {
          transcript: { var: 'output.text' },
          lang: { var: 'output.language' },
        },
        { text: 'Hi!', language: 'en' }
      );
      expect(result).toEqual({ transcript: 'Hi!', lang: 'en' });
    });
  });
});
