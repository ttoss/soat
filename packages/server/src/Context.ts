import type { DB } from './db';
import type { PolicySets } from './lib/iam';
import type { OnBehalfOf } from './lib/onBehalfOf';

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
     * `srn:{project}:{resourceType}:*` so resource-scoped policy statements are
     * enforced; when omitted the probe falls back to the project-wildcard
     * `srn:{project}:*:*` (used only where the project itself is the target,
     * e.g. `projects:*` actions).
     */
    resourceType?: string;
  }) => Promise<number[] | undefined | null>;
  /**
   * The caller's effective policy sets for the given project, each of which a
   * request must satisfy (`resolvePolicySets`); none when the credential is
   * pinned elsewhere. The policy compiler turns them into SQL access filters.
   */
  getPolicies: (projectPublicId: string) => Promise<PolicySets>;
  /** Public string id (`key_...`) of the API key used to authenticate, if any. */
  apiKeyPublicId?: string;
  /** Internal numeric DB id of the project the API key is scoped to. */
  apiKeyProjectId?: number;
  /** Public string id of the project the API key is scoped to. */
  apiKeyProjectPublicId?: string;
  /**
   * Internal numeric ids of the policies the API key is narrowed to. Absent
   * when the key carries no policy boundary.
   */
  apiKeyPolicyIds?: number[];
  /**
   * True for an admin's API key bound to no project and narrowed by no policy
   * of its own: the deployment's control plane, whose requests are operator
   * traffic rather than any project's (`requestAttribution.ts`).
   */
  isControlPlaneKey?: boolean;
  /** Public string id of the project an OAuth token is scoped to. */
  oauthProjectPublicId?: string;
  /**
   * True when the caller authenticated with a trigger run-as token (`trg`
   * claim). Used by the fire endpoint to reject trigger→trigger recursion.
   */
  isTriggerToken?: boolean;
  /**
   * True when the caller authenticated with a run-as token (`orn` claim) — the
   * short-lived credential durable, request-less work re-mints for its own
   * platform self-calls (`orchestrationRunToken.ts`).
   *
   * It marks *how* the request arrived, never what it may do: the `orn` value
   * is not an authorization input, and the boundary a run token carries is
   * resolved separately in `resolveScopedBoundaryDocs`. The one thing it tells
   * a handler is that the caller is machinery continuing a chain rather than a
   * person starting one — which is what lets the task engine bound a composed
   * dispatch→transition→dispatch cycle that otherwise looks like a series of
   * ordinary user moves.
   */
  isRunToken?: boolean;
  /**
   * The work a run token acts for (its `orn`). Read only to refuse a write
   * back into the work that minted it, so it can narrow and never grant.
   */
  runWorkPublicId?: string;
  /**
   * The tool call the request writes on behalf of, from a verified
   * `On-Behalf-Of` assertion (`lib/onBehalfOf.ts`). Recorded, and read only to
   * refuse a write back into the work whose generation made the call.
   */
  onBehalfOf?: OnBehalfOf;
};

export type Context = {
  db: DB;
  authUser?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;
