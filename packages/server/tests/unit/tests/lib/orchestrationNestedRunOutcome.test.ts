import { DomainError } from 'src/errors';
import { assertNestedRunCompleted } from 'src/lib/orchestrationNestedRunOutcome';

/**
 * The inputs no entry point produces deterministically. A child is started
 * with `wait: true` and handed back settled, so a `cancelled` child only
 * arises from a cancellation racing the parent's own synchronous drive, and a
 * child error bag without string fields only from a writer other than
 * `buildRunError`. A failed child's code and message propagating, and the
 * fallback code for an unregistered one, are pinned end to end in
 * `rest/orchestrationRunDepth.test.ts` and `rest/orchestrations.test.ts`.
 */
describe('assertNestedRunCompleted', () => {
  const run = (overrides: {
    status: string;
    error?: object | null;
  }): { id: string; status: string; error: object | null } => {
    return {
      id: 'orch_run_child',
      status: overrides.status,
      error: overrides.error ?? null,
    };
  };

  const thrownBy = (args: {
    run: { id: string; status: string; error: object | null };
  }): DomainError => {
    try {
      assertNestedRunCompleted({ run: args.run, nodeId: 'delegate' });
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected assertNestedRunCompleted to throw');
  };

  test.each(['awaiting_input', 'sleeping', 'running'])(
    'accepts a child that is %s, which has not settled',
    (status) => {
      expect(() => {
        return assertNestedRunCompleted({
          run: run({ status }),
          nodeId: 'delegate',
        });
      }).not.toThrow();
    }
  );

  test.each(['cancelled', 'expired'])(
    'names the child and its status when a %s child carries no error',
    (status) => {
      const error = thrownBy({ run: run({ status }) });
      expect(error.code).toBe('ORCHESTRATION_NESTED_RUN_FAILED');
      expect(error.message).toBe(
        `Child run 'orch_run_child' started by node 'delegate' settled '${status}'.`
      );
      expect(error.meta).toEqual({
        nodeId: 'delegate',
        orchestrationRunId: 'orch_run_child',
        status,
      });
    }
  );

  test('ignores a non-string code or message on the child', () => {
    const error = thrownBy({
      run: run({ status: 'failed', error: { code: 7, message: null } }),
    });
    expect(error.code).toBe('ORCHESTRATION_NESTED_RUN_FAILED');
    expect(error.message).toMatch(/settled 'failed'/);
  });
});
