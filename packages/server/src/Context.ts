import type { DB } from './db';

export type AuthUser = {
  id: number;
  publicId: string;
  username: string;
  role: 'admin' | 'user';
  isAllowed: (projectPublicId: string, action: string) => Promise<boolean>;
  /**
   * Resolves the internal project IDs the caller may access for the given action.
   * - Explicit projectPublicId: verifies permission and returns [id], or null if forbidden/not found.
   * - API key (no explicit id): infers from the key's scoped project.
   * - JWT admin (no explicit id): returns undefined (no filter — all projects).
   * - JWT user (no explicit id): enumerates all projects the user has access to.
   */
  resolveProjectIds: (args: {
    projectPublicId?: string;
    action: string;
  }) => Promise<number[] | undefined | null>;
  apiKeyProjectId?: string;
};

export type Context = {
  db: DB;
  authUser?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;
