import { extractApiErrorMessage } from 'src/mcp/dispatchApi';

/**
 * `extractApiErrorMessage` is tested directly rather than through the MCP
 * endpoint: it is a pure function over the several body shapes an error can
 * arrive in (see `.claude/rules/errors.md`), and reaching each shape through a
 * route would mean provoking a different failure per case while the assertion
 * — which message text survives — stays the same.
 *
 * What the message is *used for* is pinned at the entry point instead, in
 * `rest/mcp.test.ts`: that a failed tool call surfaces as an error carrying this
 * text, rather than as a result.
 */
describe('extractApiErrorMessage', () => {
  test('returns the string as-is for a plain string error body', () => {
    expect(extractApiErrorMessage({ error: 'Orchestration not found' })).toBe(
      'Orchestration not found'
    );
  });

  test('extracts message from a DomainError-shaped { code, message } body', () => {
    expect(
      extractApiErrorMessage({
        error: { code: 'ORCHESTRATION_NOT_FOUND', message: 'Not found.' },
      })
    ).toBe('Not found.');
  });

  test('returns null when the error field is an object without a message', () => {
    expect(extractApiErrorMessage({ error: { code: 'SOMETHING' } })).toBeNull();
  });

  test('returns null for a body with no error field', () => {
    expect(extractApiErrorMessage({ ok: true })).toBeNull();
  });

  test('returns null for a non-object body', () => {
    expect(extractApiErrorMessage(null)).toBeNull();
    expect(extractApiErrorMessage('oops')).toBeNull();
  });

  test('returns null for a non-string message, so the caller falls back to the status', () => {
    expect(extractApiErrorMessage({ error: { message: { nested: 1 } } })).toBe(
      null
    );
  });
});
