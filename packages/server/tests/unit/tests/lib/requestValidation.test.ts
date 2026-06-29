import { DomainError } from '../../../../src/errors';
import { validateRequestBody } from '../../../../src/lib/requestValidation';

const expectThrows = (fn: () => void): DomainError => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  return thrown as DomainError;
};

describe('validateRequestBody', () => {
  describe('unknown fields', () => {
    test('passes when every top-level field is known (inline schema)', () => {
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/projects',
          body: { name: 'Acme' },
        });
      }).not.toThrow();
    });

    test('passes when every top-level field is known ($ref schema)', () => {
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/agents',
          body: { aiProviderId: 'aip_1', name: 'Alpha', maxSteps: 5 },
        });
      }).not.toThrow();
    });

    test('rejects an unknown top-level field with a bare path', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/agents',
          body: { aiProviderId: 'aip_1', prompt: 'oops', foo: 1 },
        });
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.httpStatus).toBe(400);
      expect(error.meta).toEqual({ unknownFields: ['prompt', 'foo'] });
      expect(error.message).toMatch(/Unknown field/);
    });

    test('rejects an unknown nested field with a dotted path', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/agents',
          body: { aiProviderId: 'aip_1', knowledgeConfig: { bogus: true } },
        });
      });
      expect(error.meta).toEqual({ unknownFields: ['knowledgeConfig.bogus'] });
    });

    test('rejects an unknown field inside an array item with an indexed path', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/orchestrations',
          body: {
            name: 'flow',
            nodes: [{ id: 'n1', type: 'agent', bogus: 1 }],
            edges: [],
          },
        });
      });
      expect(error.meta).toEqual({ unknownFields: ['nodes.0.bogus'] });
    });

    test('compares in camelCase (snake_case top-level key is unknown)', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/agents',
          body: { ai_provider_id: 'aip_1' },
        });
      });
      expect(error.message).toMatch(/ai_provider_id/);
    });
  });

  describe('skipped (open / ambiguous) levels', () => {
    test('no-ops for an open additionalProperties map route (tags)', () => {
      expect(() => {
        return validateRequestBody({
          method: 'put',
          path: '/actors/:actor_id/tags',
          body: { anything: 'goes', another: 'tag' },
        });
      }).not.toThrow();
    });

    test('skips a nested additionalProperties map (orchestration input_mapping)', () => {
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/orchestrations',
          body: {
            name: 'flow',
            nodes: [{ id: 'n1', type: 'agent', inputMapping: { any: 1 } }],
            edges: [],
          },
        });
      }).not.toThrow();
    });

    test('skips a nested oneOf union (generation message content)', () => {
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/agents/:agent_id/generate',
          body: { messages: [{ role: 'user', content: { unusual: 'shape' } }] },
        });
      }).not.toThrow();
    });

    test('accepts a policy statement condition (open object) after the spec fix', () => {
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/policies',
          body: {
            document: {
              statement: [
                {
                  effect: 'Allow',
                  action: ['files:GetFile'],
                  condition: {
                    StringEquals: { 'soat:ResourceTag/env': 'prod' },
                  },
                },
              ],
            },
          },
        });
      }).not.toThrow();
    });

    test('no-ops for an unknown route with no spec entry', () => {
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/this/route/does/not/exist',
          body: { whatever: true },
        });
      }).not.toThrow();
    });
  });

  describe('required fields (top level only)', () => {
    test('rejects a missing top-level required field', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/projects',
          body: {},
        });
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.meta).toEqual({ missingFields: ['name'] });
      expect(error.message).toMatch(/Missing required field/);
    });

    test('treats an empty string as missing for a required string field', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/projects',
          body: { name: '' },
        });
      });
      expect(error.meta).toEqual({ missingFields: ['name'] });
    });

    test('does not enforce required fields nested inside objects', () => {
      // OrchestrationNode requires id+type, but nested required is out of scope —
      // only the unknown-field walk runs nested. A node missing `type` passes.
      expect(() => {
        return validateRequestBody({
          method: 'post',
          path: '/orchestrations',
          body: { name: 'flow', nodes: [{ id: 'n1' }], edges: [] },
        });
      }).not.toThrow();
    });

    test('does not throw for a route with no required fields and an empty body', () => {
      expect(() => {
        return validateRequestBody({
          method: 'patch',
          path: '/agents/:agent_id',
          body: {},
        });
      }).not.toThrow();
    });

    test('reports both unknown and missing fields together', () => {
      const error = expectThrows(() => {
        return validateRequestBody({
          method: 'post',
          path: '/agents',
          body: { ai_provider_id: 'aip_1' },
        });
      });
      // snake_case key is unknown AND the camelCase required field is missing
      expect(error.meta).toEqual({
        unknownFields: ['ai_provider_id'],
        missingFields: ['aiProviderId'],
      });
    });
  });
});
