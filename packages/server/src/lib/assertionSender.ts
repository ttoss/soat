import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { resolveBearerAuthUser } from '../middleware/auth';
import type { AssertionAuthority } from './assertionAuthority';
import {
  type PolicyDocument,
  type PolicySets,
  validatePolicyDocument,
} from './iam';

const log = createDebug('soat:assertionSender');

/** A set with no document: it allows nothing. */
const NOTHING: PolicySets = [[]];

export type SenderCredential = Pick<
  AuthUser,
  'getPolicies' | 'iamToken' | 'onBehalfOfPrincipal'
>;

/**
 * Whose authority a tool call carries in its assertion. `caller` is the
 * request's own resolved credential, narrowings included; without one the
 * credential the work replays (`authHeader`) is resolved. `agentPolicy` is
 * the calling agent's `policy_ids`, as every `builtin` call of the turn is
 * held to it.
 */
export type AssertionSender = {
  caller?: SenderCredential;
  authHeader: string | undefined;
  agentPolicy?: unknown;
};

const agentPolicySets = (agentPolicy: unknown): PolicySets => {
  if (!agentPolicy) return [];
  return validatePolicyDocument(agentPolicy).valid
    ? [[agentPolicy as PolicyDocument]]
    : NOTHING;
};

/**
 * The authority a call's assertion seals: the sender's credential in the
 * tool's project ∩ the agent's `policy_ids`. A sender with no credential, or
 * one reaching no further than another project, allows nothing. A
 * generation's stored identity is read when the assertion returns, since the
 * row may not exist yet when its tools are resolved.
 */
export const resolveSenderAuthority = async (args: {
  sender: AssertionSender;
  projectPublicId: string;
}): Promise<AssertionAuthority> => {
  const { sender, projectPublicId } = args;
  const credential =
    sender.caller ??
    (await resolveBearerAuthUser({ db, authHeader: sender.authHeader }));
  const credentialSets = credential
    ? await credential.getPolicies(projectPublicId)
    : [];
  const principal =
    credential?.iamToken?.principal ?? credential?.onBehalfOfPrincipal;
  log(
    'resolveSenderAuthority: project=%s credential=%s',
    projectPublicId,
    credentialSets.length > 0
  );
  return {
    sets: [
      ...(credentialSets.length > 0 ? credentialSets : NOTHING),
      ...agentPolicySets(sender.agentPolicy),
    ],
    ...(principal ? { principal } : {}),
  };
};
