import { DomainError } from '../../../../src/errors';
import { rejectUnknownFields } from '../../../../src/lib/requestValidation';

describe('rejectUnknownFields', () => {
  test('does not throw when every field is known (inline schema route)', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'post',
        path: '/projects',
        body: { name: 'Acme' },
      });
    }).not.toThrow();
  });

  test('does not throw when every field is known ($ref schema route)', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'post',
        path: '/agents',
        body: { aiProviderId: 'aip_1', name: 'Alpha', maxSteps: 5 },
      });
    }).not.toThrow();
  });

  test('does not throw for an empty body', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'post',
        path: '/agents',
        body: {},
      });
    }).not.toThrow();
  });

  test('throws a VALIDATION_FAILED DomainError listing unknown fields', () => {
    let thrown: unknown;
    try {
      rejectUnknownFields({
        method: 'post',
        path: '/agents',
        body: { aiProviderId: 'aip_1', prompt: 'oops', foo: 1 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DomainError);
    const domainError = thrown as DomainError;
    expect(domainError.code).toBe('VALIDATION_FAILED');
    expect(domainError.httpStatus).toBe(400);
    expect(domainError.meta).toEqual({ unknownFields: ['prompt', 'foo'] });
    expect(domainError.message).toMatch(/prompt/);
    expect(domainError.message).toMatch(/foo/);
    expect(domainError.message).toMatch(/Allowed:/);
    expect(domainError.message).toMatch(/aiProviderId/);
  });

  test('resolves the route via the OpenAPI path key (param + prefix normalized)', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'put',
        path: '/agents/:agent_id',
        body: { name: 'renamed' },
      });
    }).not.toThrow();

    expect(() => {
      return rejectUnknownFields({
        method: 'put',
        path: '/agents/:agent_id',
        body: { projectId: 'prj_1' }, // create-only field — not on UpdateAgentRequest
      });
    }).toThrow(/projectId/);
  });

  test('compares in camelCase (snake_case keys are treated as unknown)', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'post',
        path: '/agents',
        body: { ai_provider_id: 'aip_1' },
      });
    }).toThrow(/ai_provider_id/);
  });

  test('no-ops for an open additionalProperties map route (tags)', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'put',
        path: '/actors/:actor_id/tags',
        body: { anything: 'goes', another: 'tag' },
      });
    }).not.toThrow();
  });

  test('no-ops for an unknown route with no spec entry', () => {
    expect(() => {
      return rejectUnknownFields({
        method: 'post',
        path: '/this/route/does/not/exist',
        body: { whatever: true },
      });
    }).not.toThrow();
  });
});
