import { DomainError } from 'src/errors';
import {
  cancelOrchestrationRun,
  resumeOrchestrationRun,
  submitHumanInput,
} from 'src/lib/orchestrationRunActions';

// These tests cover the optional-parameter branches (projectIds and
// orchestrationPublicId) that the REST routes always populate, as well as
// the !run not-found branch in each function.  All calls intentionally use
// a non-existent runPublicId so they throw ORCHESTRATION_RUN_NOT_FOUND after
// the branch under test has been exercised.

describe('cancelOrchestrationRun – optional params branches', () => {
  test('without projectIds hits the args.projectIds=false branch and throws not-found', async () => {
    await expect(
      cancelOrchestrationRun({ runPublicId: 'run_nonexistent_test_1' })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('without orchestrationPublicId hits the orchestrationPublicId=false branch', async () => {
    await expect(
      cancelOrchestrationRun({
        runPublicId: 'run_nonexistent_test_2',
        projectIds: [999999],
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('with orchestrationPublicId hits the include-override branch', async () => {
    await expect(
      cancelOrchestrationRun({
        runPublicId: 'run_nonexistent_test_3',
        orchestrationPublicId: 'orch_nonexistent',
        projectIds: [999999],
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('throws DomainError for non-existent run', async () => {
    await expect(
      cancelOrchestrationRun({ runPublicId: 'run_nonexistent_test_4' })
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe('submitHumanInput – optional params branches', () => {
  test('without projectIds hits the projectIds=false branch and throws not-found', async () => {
    await expect(
      submitHumanInput({
        runPublicId: 'run_nonexistent_test_5',
        nodeId: 'n1',
        output: {},
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('without orchestrationPublicId hits the ternary-false branch', async () => {
    await expect(
      submitHumanInput({
        runPublicId: 'run_nonexistent_test_6',
        nodeId: 'n1',
        output: {},
        projectIds: [999999],
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('with orchestrationPublicId hits the ternary-true branch', async () => {
    await expect(
      submitHumanInput({
        runPublicId: 'run_nonexistent_test_7',
        nodeId: 'n1',
        output: {},
        orchestrationPublicId: 'orch_nonexistent',
        projectIds: [999999],
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });
});

describe('resumeOrchestrationRun – optional params branches', () => {
  test('without projectIds hits the projectIds=false branch and throws not-found', async () => {
    await expect(
      resumeOrchestrationRun({ runPublicId: 'run_nonexistent_test_8' })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('without orchestrationPublicId hits the ternary-false branch', async () => {
    await expect(
      resumeOrchestrationRun({
        runPublicId: 'run_nonexistent_test_9',
        projectIds: [999999],
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  test('with orchestrationPublicId hits the ternary-true branch', async () => {
    await expect(
      resumeOrchestrationRun({
        runPublicId: 'run_nonexistent_test_10',
        orchestrationPublicId: 'orch_nonexistent',
        projectIds: [999999],
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });
});
