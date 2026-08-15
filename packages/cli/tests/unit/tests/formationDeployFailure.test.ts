import { resolveFailureMessage } from '../../../src/cli-wrappers/index';
import { createCliTestClient } from '../testClient';

const cliTestClient = createCliTestClient();

const failedDeploy = {
  id: 'form_V1StGXR8Z5jdHi6B',
  status: 'failed',
  error: {
    code: 'VALIDATION_FAILED',
    message:
      "dataset_id is immutable: item 'dsit_1' belongs to 'dset_1'. Declare a new dataset_item instead.",
    meta: { logical_id: 'case1', resource_type: 'dataset_item' },
  },
};

describe('resolveFailureMessage', () => {
  test('reports a deploy that answered 2xx with status failed', () => {
    const message = resolveFailureMessage({
      commandName: 'update-formation',
      data: failedDeploy,
    });

    expect(message).toContain('case1');
    expect(message).toContain('VALIDATION_FAILED');
    expect(message).toContain('dataset_id is immutable');
  });

  test('says where to look when the body carries no error bag', () => {
    const message = resolveFailureMessage({
      commandName: 'create-formation',
      data: { id: 'form_1', status: 'failed' },
    });

    expect(message).toContain('failed');
    expect(message).toContain('list-formation-events');
  });

  test('a successful deploy is not a failure', () => {
    expect(
      resolveFailureMessage({
        commandName: 'update-formation',
        data: { id: 'form_1', status: 'active', error: null },
      })
    ).toBeNull();
  });

  // Reading a failed stack back is a successful read: only the command that
  // *ran* the deploy reports the deploy's outcome as its own exit status.
  test('a read of a failed formation is not a failure', () => {
    expect(
      resolveFailureMessage({
        commandName: 'get-formation',
        data: failedDeploy,
      })
    ).toBeNull();
  });

  test('a command with no wrapper is never classified', () => {
    expect(
      resolveFailureMessage({
        commandName: 'start-orchestration-run',
        data: { id: 'run_1', status: 'failed', error: { message: 'boom' } },
      })
    ).toBeNull();
  });

  test('a non-object payload is not a failure', () => {
    expect(
      resolveFailureMessage({ commandName: 'update-formation', data: 'ok' })
    ).toBeNull();
  });
});

describe('update-formation exit status', () => {
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    cliTestClient.reset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // `process.exit` would tear down the jest worker; the CLI does nothing
    // after it, so swallowing it leaves the command's observable behavior
    // (what it printed, what code it asked for) intact.
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('exits non-zero and prints the reason when the deploy failed', async () => {
    cliTestClient.setResponse({
      body: JSON.stringify(failedDeploy),
      contentType: 'application/json',
    });

    await cliTestClient.call([
      'update-formation',
      '--formation-id',
      'form_V1StGXR8Z5jdHi6B',
      '--template',
      '{"resources":{}}',
    ]);

    // The payload still goes to stdout, so `$(soat update-formation …)` and a
    // `| jq` pipeline keep working — the exit code is what changed.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"status": "failed"')
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('dataset_id is immutable')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits zero when the deploy succeeded', async () => {
    cliTestClient.setResponse({
      body: JSON.stringify({ id: 'form_1', status: 'active', error: null }),
      contentType: 'application/json',
    });

    await cliTestClient.call([
      'update-formation',
      '--formation-id',
      'form_1',
      '--template',
      '{"resources":{}}',
    ]);

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
