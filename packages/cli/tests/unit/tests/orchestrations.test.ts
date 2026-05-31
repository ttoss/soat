import { createCliTestClient } from '../testClient';

describe('orchestration run commands', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('start-orchestration-run performs POST to runs endpoint', async () => {
    const requests = await cliTestClient.call([
      'start-orchestration-run',
      '--orchestration-id',
      'orch_test',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/orchestrations/orch_test/runs');
  });

  test('list-orchestration-runs performs GET to runs endpoint', async () => {
    const requests = await cliTestClient.call([
      'list-orchestration-runs',
      '--orchestration-id',
      'orch_test',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/orchestrations/orch_test/runs');
  });

  test('get-orchestration-run performs GET to specific run endpoint', async () => {
    const requests = await cliTestClient.call([
      'get-orchestration-run',
      '--orchestration-id',
      'orch_test',
      '--run-id',
      'run_test',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe(
      '/api/v1/orchestrations/orch_test/runs/run_test'
    );
  });

  test('cancel-orchestration-run performs POST to cancel endpoint', async () => {
    const requests = await cliTestClient.call([
      'cancel-orchestration-run',
      '--orchestration-id',
      'orch_test',
      '--run-id',
      'run_test',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe(
      '/api/v1/orchestrations/orch_test/runs/run_test/cancel'
    );
  });

  test('resume-orchestration-run performs POST to resume endpoint', async () => {
    const requests = await cliTestClient.call([
      'resume-orchestration-run',
      '--orchestration-id',
      'orch_test',
      '--run-id',
      'run_test',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe(
      '/api/v1/orchestrations/orch_test/runs/run_test/resume'
    );
  });
});

describe('deprecated orchestration run command aliases', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test.each([
    ['start-run', 'start-orchestration-run'],
    ['list-runs', 'list-orchestration-runs'],
    ['get-run', 'get-orchestration-run'],
    ['cancel-run', 'cancel-orchestration-run'],
    ['resume-run', 'resume-orchestration-run'],
  ])(
    '%s is a deprecated alias for %s and emits a warning',
    async (oldName, newName) => {
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const args: string[] = [oldName, '--orchestration-id', 'orch_test'];
      if (['get-run', 'cancel-run', 'resume-run'].includes(oldName)) {
        args.push('--run-id', 'run_test');
      }

      await cliTestClient.call(args);

      const warningCalls = errorSpy.mock.calls.flat().join('\n');
      expect(warningCalls).toContain(`"${oldName}" is deprecated`);
      expect(warningCalls).toContain(`"${newName}" instead`);

      expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});
