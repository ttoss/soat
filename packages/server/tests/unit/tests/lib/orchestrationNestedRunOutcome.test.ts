import { DomainError } from 'src/errors';
import { assertNestedRunCompleted } from 'src/lib/orchestrationNestedRunOutcome';

/**
 * A pure decision over a settled child run. Tested directly because two of its
 * inputs have no deterministic entry point: a `cancelled` or `expired` child
 * only arises from a cancellation racing the parent's own synchronous drive.
 * The `failed` paths are covered end-to-end in
 * `rest/orchestrationRunDepth.test.ts` as well.
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

  test.each(['succeeded', 'awaiting_input', 'sleeping', 'running'])(
    'accepts a child that is %s',
    (status) => {
      expect(() => {
        return assertNestedRunCompleted({
          run: run({ status }),
          nodeId: 'delegate',
        });
      }).not.toThrow();
    }
  );

  test("fails under the child's own code, message unwrapped", () => {
    try {
      assertNestedRunCompleted({
        run: run({
          status: 'failed',
          error: {
            code: 'ORCHESTRATION_RUN_DEPTH_LIMIT',
            message: 'would reach nesting depth 11, past the limit of 10',
          },
        }),
        nodeId: 'delegate',
      });
      throw new Error('expected assertNestedRunCompleted to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe('ORCHESTRATION_RUN_DEPTH_LIMIT');
      expect(domainError.message).toBe(
        'would reach nesting depth 11, past the limit of 10'
      );
      expect(domainError.meta).toEqual({
        nodeId: 'delegate',
        orchestrationRunId: 'orch_run_child',
        status: 'failed',
      });
    }
  });

  test('falls back to its own code when the child carries an unregistered one', () => {
    try {
      assertNestedRunCompleted({
        run: run({
          status: 'failed',
          error: { code: 'UNKNOWN', message: '{"type":"Unknown Operator"}' },
        }),
        nodeId: 'delegate',
      });
      throw new Error('expected assertNestedRunCompleted to throw');
    } catch (error) {
      expect((error as DomainError).code).toBe(
        'ORCHESTRATION_NESTED_RUN_FAILED'
      );
      expect((error as DomainError).message).toBe(
        '{"type":"Unknown Operator"}'
      );
    }
  });

  test.each(['cancelled', 'expired'])(
    'names the child and its status when a %s child carries no error',
    (status) => {
      try {
        assertNestedRunCompleted({ run: run({ status }), nodeId: 'delegate' });
        throw new Error('expected assertNestedRunCompleted to throw');
      } catch (error) {
        expect((error as DomainError).code).toBe(
          'ORCHESTRATION_NESTED_RUN_FAILED'
        );
        expect((error as DomainError).message).toBe(
          `Child run 'orch_run_child' started by node 'delegate' settled '${status}'.`
        );
      }
    }
  );

  test('ignores a non-string code or message on the child', () => {
    try {
      assertNestedRunCompleted({
        run: run({ status: 'failed', error: { code: 7, message: null } }),
        nodeId: 'delegate',
      });
      throw new Error('expected assertNestedRunCompleted to throw');
    } catch (error) {
      expect((error as DomainError).code).toBe(
        'ORCHESTRATION_NESTED_RUN_FAILED'
      );
      expect((error as DomainError).message).toMatch(/settled 'failed'/);
    }
  });
});
