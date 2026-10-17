import createDebug from 'debug';

import { emitLoadedRecordEvent } from './recordEvents';
import { type SessionRow, sessions } from './sessionAccessor';
import { mapSession } from './sessionMapper';
import type { SoatEventTypeFor } from './soatEvents';
import { rollUpUsageTotals } from './usageAggregate';

const log = createDebug('soat:sessions');

/**
 * The session as `GET` answers it: the record plus what its own turns cost. A
 * fork is a session of its own, so it starts at zero rather than inheriting
 * what the history it copied cost.
 */
export const readSessionRecord = async (session: SessionRow) => {
  const usage = await rollUpUsageTotals({
    projectId: session.projectId,
    from: null,
    to: null,
    sessionId: session.id,
  });
  return mapSession(session, usage);
};

/** Emits a session event carrying the session as `GET` answers it. */
export const emitSessionEvent = (args: {
  type: SoatEventTypeFor<'session'>;
  session: { id?: unknown; publicId: string; projectId: number };
}): Promise<void> => {
  log('emitSessionEvent: type=%s id=%s', args.type, args.session.publicId);
  return emitLoadedRecordEvent({
    type: args.type,
    projectId: args.session.projectId,
    resourceType: 'session',
    resourceId: args.session.publicId,
    load: async () => {
      return readSessionRecord(await sessions.reload(args.session));
    },
  });
};
