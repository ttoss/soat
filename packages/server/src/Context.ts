import type { DB } from './db';
import type { PolicyDocument } from './lib/iam';

export type AuthUser = {
  id: number;
  publicId: string;
  username: string;
  role: 'admin' | 'user';
  isAllowed: (args: {
    projectPublicId: string;
    action: string;
    resource?: string;
    /** Check against multiple SRNs — any Allow wins, any Deny loses. Used for path-based SRN fallback. */
    resources?: string[];
    context?: Record<string, string>;
  }) => Promise<boolean>;
  /**
   * Resolves the internal project IDs the caller may access for the given action.
   * - Explicit projectPublicId: verifies permission and returns [id], or null if forbidden/not found.
   * - project key (no explicit id): infers from the key's scoped project.
   * - JWT admin (no explicit id): returns undefined (no filter — all projects).
   * - JWT user (no explicit id): enumerates all projects the user has access to.
   */
  resolveProjectIds: (args: {
    projectPublicId?: string;
    action: string;
  }) => Promise<number[] | undefined | null>;
  /**
   * Returns the effective PolicyDocuments for the caller scoped to the given
   * project. Used by the policy compiler to generate SQL-level access filters.
   * - JWT admin: returns a single unrestricted Allow-all policy.
   * - JWT user / project key: returns the actual policy documents.
   */
  getPolicies: (projectPublicId: string) => Promise<PolicyDocument[]>;
  projectKeyProjectId?: string;
};

export type Context = {
  db: DB;
  authUser?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;
