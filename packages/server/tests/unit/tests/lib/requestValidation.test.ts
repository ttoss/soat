import { DomainError } from '../../../../src/errors';
import { rejectUnknownFields } from '../../../../src/lib/requestValidation';

describe('rejectUnknownFields', () => {
  test('does not throw when every field is known', () => {
    expect(() => {
      return rejectUnknownFields({
        schemaName: 'CreateAgentRequest',
        body: { aiProviderId: 'aip_1', name: 'Alpha', maxSteps: 5 },
      });
    }).not.toThrow();
  });

  test('does not throw for an empty body', () => {
    expect(() => {
      return rejectUnknownFields({
        schemaName: 'CreateAgentRequest',
        body: {},
      });
    }).not.toThrow();
  });

  test('throws a VALIDATION_FAILED DomainError listing unknown fields', () => {
    let thrown: unknown;
    try {
      rejectUnknownFields({
        schemaName: 'CreateAgentRequest',
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
    // the message lists both the offending fields and the allowed set
    expect(domainError.message).toMatch(/prompt/);
    expect(domainError.message).toMatch(/foo/);
    expect(domainError.message).toMatch(/Allowed:/);
    expect(domainError.message).toMatch(/aiProviderId/);
  });

  test('compares in camelCase (snake_case keys are treated as unknown)', () => {
    // The caseTransform middleware converts inbound bodies to camelCase before
    // handlers run, so a literal snake_case key reaching here is genuinely
    // unexpected and must be rejected.
    expect(() => {
      return rejectUnknownFields({
        schemaName: 'CreateAgentRequest',
        body: { ai_provider_id: 'aip_1' },
      });
    }).toThrow(/ai_provider_id/);
  });
});
