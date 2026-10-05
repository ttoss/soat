import { DomainError } from 'src/errors';
import { resumeOrchestrationRunExecution } from 'src/lib/orchestrationEngine';

import {
  type RunInstance,
  setupDeletedOrchestrationRuns,
} from '../../fixtures/deletedOrchestrationRun';

/**
 * A resume request that loaded a run while its orchestration was being
 * deleted. The background drivers' side of the same race is in
 * `jobs/orchestrationDeletedMidRun.test.ts`.
 */
describe('a resume handed a run whose orchestration is gone', () => {
  let runOfDeletedOrchestration: (
    overrides: Record<string, unknown>
  ) => Promise<RunInstance>;

  beforeAll(async () => {
    ({ runOfDeletedOrchestration } = await setupDeletedOrchestrationRuns({
      prefix: 'orchdeletedresume',
    }));
  });

  test('throws, so the request answers with the error', async () => {
    const run = await runOfDeletedOrchestration({ status: 'awaiting_input' });

    await expect(resumeOrchestrationRunExecution({ run })).rejects.toThrow(
      new DomainError(
        'ORCHESTRATION_NOT_FOUND',
        'Orchestration for run not found.'
      )
    );
  });
});
