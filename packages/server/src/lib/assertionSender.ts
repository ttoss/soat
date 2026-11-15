import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { authUserOfWork } from '../middleware/auth';
import { type AgentAuthority, boundarySets } from './agentAuthority';
import type { AssertionAuthority } from './assertionAuthority';
import type { PolicySets } from './iam';
import type { WorkAuthority } from './workAuthority';

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
 * authority the work stores is resolved. A sender with neither sends nothing
 * (`meterToolExecution`). `agentAuthority` is the calling agent's, as every
 * `builtin` call of the turn is held to its boundary.
 */
export type AssertionSender = {
  caller?: SenderCredential;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
};

const credentialOf = async (
  sender: AssertionSender
): Promise<SenderCredential | undefined> => {
  if (sender.caller) return sender.caller;
  return sender.authority
    ? authUserOfWork({ db, authority: sender.authority })
    : undefined;
};

/**
 * The authority a call's assertion seals: the sender's credential in the
 * tool's project ∩ the agent's boundary. A sender with no credential, or
 * one reaching no further than another project, allows nothing. A
 * generation's stored identity is read when the assertion returns, since the
 * row may not exist yet when its tools are resolved.
 */
export const resolveSenderAuthority = async (args: {
  sender: AssertionSender;
  projectPublicId: string;
}): Promise<AssertionAuthority> => {
  const { sender, projectPublicId } = args;
  const credential = await credentialOf(sender);
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
      ...boundarySets(sender.agentAuthority),
    ],
    ...(principal ? { principal } : {}),
  };
};
