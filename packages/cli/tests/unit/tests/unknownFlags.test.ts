import { createCliTestClient } from '../testClient';

/**
 * A flag matching no parameter of the resolved command used to be forwarded
 * rather than reported: on a GET it became a query param the server ignores, so
 * `--limitt 1` returned every row instead of one — the filter failed **open**,
 * with exit 0 and no warning.
 *
 * Request bodies already fail closed on the server (`strictFields` answers
 * `400 VALIDATION_FAILED` naming the unknown field), but a query param the spec
 * never declared cannot be caught there, so the client has to.
 */
describe('unknown flags are rejected instead of silently forwarded', () => {
  const cliTestClient = createCliTestClient();

  const expectExit1 = async (args: string[]) => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);

    await expect(cliTestClient.call(args)).rejects.toThrow('EXIT_1');

    return errorSpy.mock.calls.flat().join('\n');
  };

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('a typo on a query flag fails fast and never hits the network', async () => {
    const output = await expectExit1([
      'list-agents',
      '--project_id',
      'proj_1',
      '--limitt',
      '1',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(0);
    expect(output).toContain('limitt');
  });

  test('the error suggests the flag that was probably meant', async () => {
    const output = await expectExit1([
      'list-agents',
      '--project_id',
      'proj_1',
      '--limitt',
      '1',
    ]);

    expect(output).toContain('--limit');
  });

  test('an unknown body flag is caught locally too', async () => {
    const output = await expectExit1([
      'create-agent',
      '--project_id',
      'proj_1',
      '--name',
      'a',
      '--notarealfield',
      'x',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(0);
    expect(output).toContain('notarealfield');
  });

  test('a declared query param is still sent', async () => {
    const requests = await cliTestClient.call([
      'list-agents',
      '--project_id',
      'proj_1',
      '--limit',
      '1',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toMatchObject({ limit: '1' });
  });

  test('snake_case and kebab-case spellings both remain valid', async () => {
    const snake = await cliTestClient.call([
      'list-agents',
      '--project_id',
      'proj_1',
    ]);
    expect(snake[0]?.query).toMatchObject({ project_id: 'proj_1' });

    cliTestClient.reset();

    const kebab = await cliTestClient.call([
      'list-agents',
      '--project-id',
      'proj_1',
    ]);
    expect(kebab[0]?.query).toMatchObject({ project_id: 'proj_1' });
  });

  test('the --id alias and a positional argument are not treated as unknown', async () => {
    const byAlias = await cliTestClient.call([
      'get-formation',
      '--id',
      'frm_1',
    ]);
    expect(byAlias[0]?.path).toBe('/api/v1/formations/frm_1');

    cliTestClient.reset();

    const byPositional = await cliTestClient.call(['get-formation', 'frm_2']);
    expect(byPositional[0]?.path).toBe('/api/v1/formations/frm_2');
  });

  test('formation wrapper flags are not treated as unknown', async () => {
    const requests = await cliTestClient.call([
      'update-formation',
      '--formation_id',
      'frm_1',
      '--parameter',
      'env=prod',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ parameters: { env: 'prod' } });
  });
});
