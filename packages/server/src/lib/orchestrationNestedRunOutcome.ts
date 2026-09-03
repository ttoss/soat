/**
 * What a `loop` / `sub_orchestration` node does with a child run that did not
 * complete.
 *
 * A child run catches its own failures — `executeRun` settles the run rather
 * than letting the throw escape — so the seam handed the parent a settled
 * `failed` run and the node took `output ?? {}` from it and carried on. The
 * parent then succeeded on an empty artifact, which made every child failure a
 * silent stop; a depth-bounded run at the bottom of a recursing tree would have
 * been reported to the caller as a success (#1185).
 *
 * The same semantics a workflow `on_enter` dispatch already has
 * (`ORCHESTRATION_DISPATCH_FAILED`): a non-success *terminal* status is the
 * node's failure. A child that parked (`awaiting_input`, `sleeping`) has not
 * settled and is deliberately not covered here.
 */
import { DomainError, ERROR_CODES, type ErrorCode } from '../errors';

const NON_SUCCESS_TERMINAL_STATUSES = ['failed', 'cancelled', 'expired'];

const readErrorField = (
  error: object | null,
  field: 'code' | 'message'
): string | null => {
  if (!error) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
};

/**
 * The child's own code, so the cause reaches the run a caller reads rather than
 * stopping at the run that noticed it — the whole point of propagating at all.
 * The child's message travels with it, unwrapped: wrapping it once per level
 * would grow the text with the depth of the very trees this exists to report.
 */
const isErrorCode = (code: string | null): code is ErrorCode => {
  return code !== null && Object.hasOwn(ERROR_CODES, code);
};

export const assertNestedRunCompleted = (args: {
  run: { id: string; status: string; error: object | null };
  nodeId: string;
}): void => {
  const { run, nodeId } = args;
  if (!NON_SUCCESS_TERMINAL_STATUSES.includes(run.status)) return;

  const childCode = readErrorField(run.error, 'code');
  const childMessage = readErrorField(run.error, 'message');

  throw new DomainError(
    isErrorCode(childCode) ? childCode : 'ORCHESTRATION_NESTED_RUN_FAILED',
    childMessage ??
      `Child run '${run.id}' started by node '${nodeId}' settled '${run.status}'.`,
    {
      nodeId,
      orchestrationRunId: run.id,
      status: run.status,
    }
  );
};
