import { DomainError } from 'src/errors';
import { INTERNAL_FAILURE, toStoredError } from 'src/lib/storedError';

/**
 * A raw throw reaching a stored error is a defect no entry point produces on
 * purpose, so its branch is pinned here; a `DomainError` reaching one is
 * recorded through real runs in `rest/orchestrationNodeExecution.test.ts`.
 */
describe('toStoredError', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a DomainError keeps its code, message and meta', () => {
    const error = new DomainError(
      'TOOL_HTTP_ERROR',
      'Tool target returned HTTP 405',
      {
        tool_status_code: 405,
      }
    );
    expect(
      toStoredError({ error, opaque: INTERNAL_FAILURE, label: 'test' })
    ).toEqual({
      code: 'TOOL_HTTP_ERROR',
      message: 'Tool target returned HTTP 405',
      meta: { tool_status_code: 405 },
    });
  });

  test('a DomainError without meta records none', () => {
    const error = new DomainError('VALIDATION_FAILED', 'bad');
    expect(
      toStoredError({ error, opaque: INTERNAL_FAILURE, label: 'test' })
    ).toEqual({ code: 'VALIDATION_FAILED', message: 'bad' });
  });

  test.each([
    ['an Error', new Error('relation "secrets" does not exist')],
    ['a primitive', 'kaboom'],
    ['an object', { type: 'internal' }],
  ])('%s records the opaque failure and logs the raw value', (_, error) => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      toStoredError({ error, opaque: INTERNAL_FAILURE, label: 'test' })
    ).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal Server Error' });
    expect(logged).toHaveBeenCalledWith(
      'test: recorded as INTERNAL_ERROR',
      error
    );
  });

  test('the caller names the opaque failure', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const opaque = {
      code: 'GENERATION_FAILED' as const,
      message: 'The generation failed.',
    };
    expect(
      toStoredError({ error: new Error('x'), opaque, label: 'test' })
    ).toBe(opaque);
  });
});
