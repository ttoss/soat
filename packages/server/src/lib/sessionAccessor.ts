import { db } from '../db';
import type { ResourceIncludes } from './modelIncludes';
import { makeResourceAccessor } from './resourceAccessor';

/**
 * The association set every session read loads.
 *
 * It lives in a leaf module rather than in `sessions.ts` because
 * `sessionOperations.ts` needs it too and `sessions.ts` already imports
 * `sessionOperations.ts` — re-exporting from the owner would close a cycle.
 * One definition means a new association cannot be added to one read path and
 * silently leave the other mapping `undefined`.
 */
export const sessionIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Conversation, as: 'conversation' },
    { model: db.Actor, as: 'actor' },
  ];
};

/**
 * A session row with those associations attached — the shape `mapSession`
 * reads. Declared here for the same reason `sessionIncludes` is: the type and
 * the includes it describes must not be able to drift apart.
 */
export type SessionRow = InstanceType<(typeof db)['Session']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']>;
  conversation?: InstanceType<(typeof db)['Conversation']>;
  actor?: InstanceType<(typeof db)['Actor']> | null;
};

export const sessions = makeResourceAccessor<SessionRow>({
  model: () => {
    return db.Session;
  },
  includes: sessionIncludes,
  label: 'Session',
});
