import {
  callApi,
  extractApiErrorMessage,
  mcpAuthorizationStore,
} from 'src/mcp/callApi';

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
});

describe('callApi', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('falls back to "HTTP <status>" when the error response body is not valid JSON', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('not json', { status: 500 }));

    await expect(
      callApi({
        apiBaseUrl: 'http://localhost:5047',
        method: 'GET',
        url: '/api/v1/broken',
      })
    ).rejects.toThrow('HTTP 500');
  });

  test('returns plain text for a successful non-JSON response', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('plain text body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );

    const result = await callApi({
      apiBaseUrl: 'http://localhost:5047',
      method: 'GET',
      url: '/api/v1/text',
    });

    expect(result).toBe('plain text body');
  });

  test('forwards the authorization header from mcpAuthorizationStore', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await mcpAuthorizationStore.run('Bearer token123', async () => {
      await callApi({
        apiBaseUrl: 'http://localhost:5047',
        method: 'DELETE',
        url: '/api/v1/files/file_1',
      });
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:5047/api/v1/files/file_1',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer token123' }),
      })
    );
  });
});
