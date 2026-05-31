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
