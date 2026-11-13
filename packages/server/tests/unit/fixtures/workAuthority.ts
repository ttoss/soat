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
};
