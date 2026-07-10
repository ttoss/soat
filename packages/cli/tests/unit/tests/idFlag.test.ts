import { createCliTestClient } from '../testClient';

describe('positional id and --id alias for single-resource commands', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('a positional id is substituted into the sole path parameter', async () => {
    const requests = await cliTestClient.call(['get-formation', 'frm_123']);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/formations/frm_123');
  });

  test('--id is accepted as an alias for the sole path parameter', async () => {
    const requests = await cliTestClient.call([
      'get-formation',
      '--id',
      'frm_456',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/v1/formations/frm_456');
  });

  test('an explicit --formation_id flag still works as before', async () => {
    const requests = await cliTestClient.call([
      'get-formation',
      '--formation_id',
      'frm_789',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/v1/formations/frm_789');
  });

  test('a missing required path parameter fails fast with a clear error and never hits the network', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);

    await expect(cliTestClient.call(['get-formation'])).rejects.toThrow(
      'EXIT_1'
    );

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('formation_id');
    expect(output).not.toContain('{formation_id}');
  });
});
