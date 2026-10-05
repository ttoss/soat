import { buildRunError } from 'src/lib/orchestrationNodeRecorder';

/**
 * The thrown-value shapes no entry point produces deterministically. A
 * `DomainError`, a json-logic-engine object throw and an empty-object throw
 * are recorded through real runs in `rest/orchestrationNodeExecution.test.ts`.
 * A `fetch` failure carries its real reason on `.cause`, but under Jest the
 * runtime's `TypeError` comes from another realm and fails `instanceof Error`,
 * so its cause handling is pinned here instead; so are a primitive throw and a
 * circular object, which only third-party code throws.
 */
describe('buildRunError', () => {
  test('an Error with an Error cause appends the cause message', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.1:80');
    const error = new Error('fetch failed', { cause });
    expect(buildRunError(error)).toEqual({
      message: 'fetch failed: connect ECONNREFUSED 10.0.0.1:80',
      code: 'UNKNOWN',
    });
  });

  test('an Error with a non-Error cause appends the stringified cause', () => {
    const error = new Error('fetch failed', { cause: 'ENOTFOUND' });
    expect(buildRunError(error)).toEqual({
      message: 'fetch failed: ENOTFOUND',
      code: 'UNKNOWN',
    });
  });

  test('a primitive throw is stringified', () => {
    expect(buildRunError('kaboom')).toEqual({
      message: 'kaboom',
      code: 'UNKNOWN',
    });
  });

  test('a circular object falls back to its string form', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(buildRunError(circular)).toEqual({
      message: '[object Object]',
      code: 'UNKNOWN',
    });
  });
});
