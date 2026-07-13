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
});
