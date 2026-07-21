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
    /**
     * Resource type the action targets (e.g. `secret`, `file`). When provided,
     * the internal permission probe is scoped to the type-level SRN
     * `soat:{project}:{resourceType}:*` so resource-scoped policy statements are
     * enforced; when omitted the probe falls back to the project-wildcard
     * `soat:{project}:*:*` (used only where the project itself is the target,
     * e.g. `projects:*` actions).
     */
    resourceType?: string;
  }) => Promise<number[] | undefined | null>;
  /**
   * Returns the effective PolicyDocuments for the caller scoped to the given
   * project. Used by the policy compiler to generate SQL-level access filters.
   * - JWT admin: returns a single unrestricted Allow-all policy.
   * - JWT user / project key: returns the actual policy documents.
   */
  getPolicies: (projectPublicId: string) => Promise<PolicyDocument[]>;
  /** Public string id (`key_...`) of the API key used to authenticate, if any. */
  apiKeyPublicId?: string;
  /** Internal numeric DB id of the project the API key is scoped to. */
  apiKeyProjectId?: number;
  /** Public string id of the project the API key is scoped to. */
  apiKeyProjectPublicId?: string;
  /** Public string id of the project an OAuth token is scoped to. */
  oauthProjectPublicId?: string;
  /**
   * True when the caller authenticated with a trigger run-as token (`trg`
   * claim). Used by the fire endpoint to reject trigger→trigger recursion.
   */
  isTriggerToken?: boolean;
};

export type Context = {
  db: DB;
  authUser?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;
