import type { DB } from './db';
import type { RefusedBy } from './lib/authorizationDenial';
import type { PolicySets } from './lib/iam';
import type { OnBehalfOf } from './lib/onBehalfOf';
import type { LabeledPolicySets } from './lib/permissions';
import type { CredentialTerms } from './lib/workAuthority';

export type AuthUser = {
  /**
   * The user the credential belongs to: absent only for work a trigger's own
   * grant runs, which acts as no user.
   */
  id?: number;
  publicId?: string;
  username?: string;
  role?: 'admin' | 'user';
  /** What the credential states; work the request starts stores it. */
  terms: CredentialTerms;
  isAllowed: ((args: {
    projectPublicId: string;
    action: string;
    resource?: string;
    /** Check against multiple SRNs — any Allow wins, any Deny loses. Used for path-based SRN fallback. */
    resources?: string[];
    context?: Record<string, string>;
  }) => Promise<boolean>) & { refusedBy?: RefusedBy };
  /**
   * The internal project ids the caller may read for `action`
   * (`resolveReachableProjectIds`): `null` when refused, `undefined` (no
   * project filter) only for an {@link AuthUser.unrestricted} authority.
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
   * request must satisfy: its grant's, then each cap's. Never empty: a project
   * the credential is pinned away from yields a set allowing nothing. The
   * policy compiler turns them into SQL access filters.
   */
  getPolicies: (projectPublicId: string) => Promise<PolicySets>;
  /** `getPolicies`, each set labeled with the principal that holds it. */
  getLabeledPolicies: (projectPublicId: string) => Promise<LabeledPolicySets>;
  /**
   * The grant is unrestricted (`admin`), no cap narrows it and no project pins
   * it: what operator-only actions and an unfiltered read require.
   */
  unrestricted: boolean;
  /** The grant is unrestricted (`admin`), whatever caps or pins it. */
  operator: boolean;
  /**
   * What narrows the grant: `none`, only the presenting key's own `policy_ids`
   * (`key_policies`), or anything else (`beyond_key`). A durable credential
   * never outlives the narrowing it was made under: a `beyond_key` request
   * creates no API key, and only a `none` one consents to an OAuth client.
   */
  narrowing: 'none' | 'key_policies' | 'beyond_key';
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
  apiKeyPolicyIds?: string[];
  /** Public string id of the project an OAuth token is scoped to. */
  oauthProjectPublicId?: string;
  /** An OAuth token's consented scope claim, which narrows what it may do. */
  oauthScope?: string;
  /**
   * Set when stored work makes the request in-process: the trigger whose
   * firing began its chain, the work it drives, and the end user it serves.
   */
  work?: { trigger: string | null; work: string | null; actor?: string | null };
  /** Set for an IAM token (`POST /iam/tokens`): what the audit log records. */
  iamToken?: { jti: string; principal?: { type: string; id: string } };
  /**
   * The tool call the request writes on behalf of, from a verified
   * `On-Behalf-Of` assertion (`lib/onBehalfOf.ts`). Recorded; its generation
   * caps what the request may do (`authOnBehalfOf.ts`), and it refuses a write
   * back into the work whose generation made the call.
   */
  onBehalfOf?: OnBehalfOf;
  /**
   * The opaque principal that assertion's work acts for, sealed in it: what
   * the audit log records and a tool call this request makes carries on.
   */
  onBehalfOfPrincipal?: { type: string; id: string };
};

export type Context = {
  db: DB;
  authUser?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;
