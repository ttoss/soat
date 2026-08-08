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
