import type { WorkAuthority } from 'src/lib/workAuthority';

/**
 * A stored authority naming a user that does not exist: it lets a call through
 * the sender gate and resolves to no caller, for tests about something else.
 */
export const ORPHAN_AUTHORITY: WorkAuthority = {
  project: null,
  grant: { holder: 'user', user: 'user_orphan' },
  caps: [],
  principal: { type: 'user', id: 'user_orphan' },
  trigger: null,
  work: null,
  actsFor: null,
  toolContext: null,
  actor: null,
};

/** A stored authority acting as the user `user` with that user's own grant. */
export const userAuthority = (args: { user: string }): WorkAuthority => {
  return {
    project: null,
    grant: { holder: 'user', user: args.user },
    caps: [],
    principal: { type: 'user', id: args.user },
    trigger: null,
    work: null,
    actsFor: null,
    toolContext: null,
    actor: null,
  };
};
