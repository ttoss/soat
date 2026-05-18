import { createCliTestClient } from '../testClient';

describe('command help output', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
  });

  test('list-actors --help prints command help and exits without HTTP calls', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);

    await expect(cliTestClient.call(['list-actors', '--help'])).rejects.toThrow(
      'EXIT_0'
    );

    const output = logSpy.mock.calls.flat().join('\n');

    expect(output).toContain('Usage: soat list-actors [flags]');
    expect(output).toContain('Returns all actors the caller has access to.');
    expect(output).toContain(
      'Module docs: https://soat.ttoss.dev/docs/modules/actors'
    );
    expect(output).toContain('--project_id  <string>');
    expect(output).toContain('--limit  <integer>');

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('root --help mentions command-specific help usage', async () => {
    const stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => {
        return true;
      }) as never);
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);

    await expect(cliTestClient.call(['--help'])).rejects.toThrow('EXIT_0');

    const output = stdoutWriteSpy.mock.calls.flat().join('');

    expect(output).toContain(
      'Tip: Run `soat <command> --help` to see command-specific flags and docs.'
    );
    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(0);
  });

  test('create-agent-formation --help includes wrapper flags', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);

    await expect(
      cliTestClient.call(['create-agent-formation', '--help'])
    ).rejects.toThrow('EXIT_0');

    const output = logSpy.mock.calls.flat().join('\n');

    expect(output).toContain('Usage: soat create-agent-formation [flags]');
    expect(output).toContain(
      'Module docs: https://soat.ttoss.dev/docs/modules/agent-formations'
    );
    expect(output).toContain('--project_id  <string> [required]');
    expect(output).toContain('--template-path  <string>');
    expect(output).toContain('--parameter  <string>');
    expect(output).toContain('--env-file  <string>');

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(0);
  });
});
