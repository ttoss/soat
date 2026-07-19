import { DomainError } from 'src/errors';
import {
  SOAT_CONTEXT_CATALOG,
  validateGuardrailDocument,
} from 'src/lib/guardrailDocument';

const expectValidationError = (document: unknown, match?: RegExp) => {
  try {
    validateGuardrailDocument(document);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('VALIDATION_FAILED');
    if (match) {
      expect((error as DomainError).message).toMatch(match);
    }
    return;
  }
  throw new Error('expected validateGuardrailDocument to throw');
};

describe('validateGuardrailDocument', () => {
  describe('valid documents', () => {
    test('accepts a bare class literal', () => {
      expect(() => {
        return validateGuardrailDocument({ class: 'C' });
      }).not.toThrow();
    });

    test('accepts each of A/B/C/D as a literal', () => {
      for (const klass of ['A', 'B', 'C', 'D']) {
        expect(() => {
          return validateGuardrailDocument({ class: klass });
        }).not.toThrow();
      }
    });

    test('accepts a class expression over args with a guard over context/soat', () => {
      expect(() => {
        return validateGuardrailDocument({
          default_class: 'C',
          class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
          guard: {
            and: [
              { '<=': [{ var: 'args.amount' }, { var: 'context.max_daily' }] },
              { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
            ],
          },
          escalate: true,
        });
      }).not.toThrow();
    });

    test('accepts every key in the soat catalog', () => {
      for (const key of SOAT_CONTEXT_CATALOG) {
        expect(() => {
          return validateGuardrailDocument({
            class: 'B',
            guard: { '!=': [{ var: key }, null] },
          });
        }).not.toThrow();
      }
    });

    test('accepts a var with a default value that is itself an expression', () => {
      expect(() => {
        return validateGuardrailDocument({
          class: 'B',
          guard: {
            '<': [{ var: ['context.spent', { var: 'args.fallback' }] }, 10],
          },
        });
      }).not.toThrow();
    });
  });

  describe('structural rejections', () => {
    test('rejects a non-object document', () => {
      expectValidationError('C', /must be a JSON object/);
      expectValidationError(['C'], /must be a JSON object/);
      expectValidationError(null, /must be a JSON object/);
    });

    test('rejects an unknown top-level field', () => {
      expectValidationError({ class: 'C', rules: [] }, /unknown field 'rules'/);
    });

    test('rejects a missing class', () => {
      expectValidationError(
        { default_class: 'C' },
        /missing the required 'class'/
      );
    });

    test('rejects an invalid class literal', () => {
      expectValidationError({ class: 'E' }, /class' literal must be one of/);
    });

    test('rejects a class that is a non-logic object', () => {
      expectValidationError(
        { class: { foo: 1 } },
        /class' must be a class literal/
      );
    });

    test('rejects an invalid default_class', () => {
      expectValidationError(
        { class: 'B', default_class: 'Z' },
        /default_class' must be one of/
      );
    });

    test('rejects a guard that is not a JSON Logic expression', () => {
      expectValidationError(
        { class: 'B', guard: { foo: 1 } },
        /guard' must be a JSON Logic expression/
      );
    });

    test('rejects a non-boolean escalate', () => {
      expectValidationError(
        { class: 'B', escalate: 'yes' },
        /escalate' must be a boolean/
      );
    });
  });

  describe('variable namespace rejections (fail-closed)', () => {
    test('rejects a class expression referencing an out-of-namespace var', () => {
      expectValidationError(
        { class: { if: [{ var: 'foo.bar' }, 'B', 'C'] } },
        /class expression references an unknown variable/
      );
    });

    test('rejects a guard referencing a soat key outside the catalog', () => {
      expectValidationError(
        { class: 'B', guard: { '<': [{ var: 'soat.usage.cost_usd_90d' }, 1] } },
        /not in the soat\.\* catalog/
      );
    });

    test('rejects a bare soat namespace reference', () => {
      expectValidationError(
        { class: 'B', guard: { '!=': [{ var: 'soat' }, null] } },
        /references an unknown variable/
      );
    });

    test('accepts bare args and context namespace references', () => {
      expect(() => {
        return validateGuardrailDocument({
          class: 'B',
          guard: { and: [{ var: 'args' }, { var: 'context' }] },
        });
      }).not.toThrow();
    });
  });
});
