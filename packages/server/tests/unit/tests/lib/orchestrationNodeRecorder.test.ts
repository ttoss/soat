import { DomainError } from 'src/errors';
import { buildRunError } from 'src/lib/orchestrationNodeRecorder';

// buildRunError normalizes any thrown value into { message, code }. The
// non-Error branches (a bare object from a third-party evaluator, a primitive
// throw, a circular object) have no REST entry point that can produce them, so
// they are covered here directly.
describe('buildRunError', () => {
  test('an Error yields its message and the UNKNOWN code', () => {
    expect(buildRunError(new Error('boom'))).toEqual({
      message: 'boom',
      code: 'UNKNOWN',
    });
  });

  test('a DomainError yields its message and its own code', () => {
    const error = new DomainError('ORCHESTRATION_NODE_FAILED', 'node blew up');
    expect(buildRunError(error)).toEqual({
      message: 'node blew up',
      code: 'ORCHESTRATION_NODE_FAILED',
    });
  });

  test('a non-Error object is serialized instead of collapsing to [object Object]', () => {
    // json-logic-engine throws a bare { type: 'Unknown Operator' } for an
    // unknown operator (e.g. a multi-key map mapper).
    expect(buildRunError({ type: 'Unknown Operator' })).toEqual({
      message: '{"type":"Unknown Operator"}',
      code: 'UNKNOWN',
    });
  });

  test('an empty object falls back to String()', () => {
    expect(buildRunError({})).toEqual({
      message: '[object Object]',
      code: 'UNKNOWN',
    });
  });

  test('a primitive (string) throw is stringified', () => {
    expect(buildRunError('kaboom')).toEqual({
      message: 'kaboom',
      code: 'UNKNOWN',
    });
  });

  test('a circular object falls back to String() via the catch branch', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = buildRunError(circular) as { message: string; code: string };
    expect(result.code).toBe('UNKNOWN');
    expect(typeof result.message).toBe('string');
  });

  // `fetch` throws a generic `TypeError: fetch failed` with the real reason on
  // `.cause`. Dropping it is what made #820 unreproducible — nothing told a bad
  // host from a DNS failure or a timeout.
  test('an Error with an Error cause appends the cause message, surfacing the real network reason', () => {
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

  test('an Error with no cause is unaffected (existing behavior)', () => {
    expect(buildRunError(new Error('boom'))).toEqual({
      message: 'boom',
      code: 'UNKNOWN',
    });
  });
});
