import { db } from '../db';
import type { ResourceIncludes } from './modelIncludes';

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
