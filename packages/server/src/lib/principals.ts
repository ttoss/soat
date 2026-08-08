/**
 * The principal to credit for an action: `user` names the acting user, and
 * `api_key` names the key itself (`key_…`) so a record says *which* key acted.
 *
 * It lives in `lib` rather than beside `requestPrincipalFromCtx` (the REST
 * helper that derives one from an auth context) because a principal now
 * outlives a request: an orchestration run persists the principal that started
 * it and re-establishes it when a background worker drives the run later.
 */
export type RequestPrincipal = {
  principalType: 'user' | 'api_key';
  principalId: string;
};

/**
 * The one derivation of "who is acting" from an authenticated caller.
 *
 * `apiKeyPublicId` decides the kind, and it is set for every credential shape
 * through which a key acts: a raw `sk_` key (scoped or unscoped) and a run-as
 * token carrying a `key` claim (#887). So a record names *which* key acted
 * rather than merely that a key did — including when the actor is a background
 * drive that re-minted the key's identity.
 *
 * This lived in three hand-synced copies (the REST helper, the audit middleware,
 * the task-transition helper), each with its own paraphrase of the rule. That is
 * the shape #801 shipped through: one copy drifts, and the surface it feeds goes
 * quietly wrong while every test still passes. One function, three call sites.
 */
export const principalFromAuthUser = (authUser: {
  publicId: string;
  apiKeyPublicId?: string;
}): RequestPrincipal => {
  if (authUser.apiKeyPublicId) {
    return { principalType: 'api_key', principalId: authUser.apiKeyPublicId };
  }
  return { principalType: 'user', principalId: authUser.publicId };
};
