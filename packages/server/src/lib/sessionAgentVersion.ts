import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:session');

/**
 * Stamps the agent config version a generation ran against onto the session it
 * was dispatched for.
 *
 * Last-writer-wins, not a history: the per-turn record is
 * `generations.agent_version`, and this answers the cheaper question a rollout
 * is watched with — which config the conversation is on now.
 *
 * Never fatal, for the reason `resolveServedAgentVersion` never fails a
 * generation over a version lookup: a denormalized pointer must not undo work
 * that already ran.
 */
export const recordSessionAgentVersion = async (args: {
  sessionDbId: number | null;
  agentVersion: number | null | undefined;
}): Promise<void> => {
  if (args.sessionDbId === null || args.agentVersion == null) {
    return;
  }

  try {
    await db.Session.update(
      { agentVersion: args.agentVersion },
      { where: { id: args.sessionDbId } }
    );
  } catch (error) {
    /* istanbul ignore next -- only a broken DB write reaches here, and faking
       one would mean mocking the database this suite deliberately runs for
       real (`.claude/rules/tests.md`). */
    log(
      'recordSessionAgentVersion: failed session=%d %o',
      args.sessionDbId,
      error
    );
  }
};
