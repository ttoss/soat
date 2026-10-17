import type { db } from '../db';
import { emitSessionEvent } from './sessionEvents';

export const emitGenerationStarted = (
  session: InstanceType<(typeof db)['Session']>
) => {
  void emitSessionEvent({ type: 'sessions.generation_started', session });
};
