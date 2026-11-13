import { db } from '../db';
import type { TaskPrincipal } from './tasks';
import { parseWorkAuthority, type WorkAuthority } from './workAuthority';

/**
 * The authority the *next* state's automation runs under.
 *
 * A `user`, `api_key` or `trigger` move brings its own. An `automation` move
 * names nobody: its cause is the run recorded alongside it, so the run's stored
 * authority carries on, which keeps a chain acting as whoever fired the first
 * transition. Otherwise (an `approval`, an automation with no run) the task's
 * stored authority stays: an approver resolving a gate lends theirs to nothing.
 */
export const resolveDispatchAuthority = async (args: {
  args: {
    principal: TaskPrincipal;
    authority?: WorkAuthority | null;
    orchestrationRunId?: string | null;
  };
  task: { authority: object | null };
}): Promise<WorkAuthority | null> => {
  const move = args.args;
  const stored = parseWorkAuthority(args.task.authority);
  const { kind } = move.principal;
  if (kind === 'user' || kind === 'api_key' || kind === 'trigger') {
    return move.authority === undefined ? stored : move.authority;
  }
  if (kind !== 'automation' || !move.orchestrationRunId) return stored;
  const run = await db.OrchestrationRun.findOne({
    where: { publicId: move.orchestrationRunId },
    attributes: ['authority'],
  });
  return parseWorkAuthority(run?.authority) ?? stored;
};
