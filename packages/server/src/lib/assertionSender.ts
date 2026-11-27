import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { actsForOf } from './actsFor';
import type { AgentAuthority } from './agentAuthority';
import type { AssertionAuthority, AssertionCap } from './assertionAuthority';
import type { DeniedPrincipal } from './authorizationDenial';
import type { PolicySets } from './iam';
import { authUserUnder, turnAuthority } from './turnAuthority';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:assertionSender');

/** A set with no document: it allows nothing. */
const NOTHING: PolicySets = [[]];

export type SenderCredential = Pick<
  AuthUser,
  'getLabeledPolicies' | 'iamToken' | 'onBehalfOfPrincipal' | 'toolContextLayer'
>;

const ASSERTION = { type: 'on_behalf_of', id: null } as const;

/**
 * Whom a callback's refusal names, per cap: what acts inside the tool's
 * project keeps its name; what narrows the caller's credential is the
 * assertion's, since the tool server reads nothing of who made the call.
 */
const NAMED_THROUGH_ASSERTION: Record<DeniedPrincipal['type'], boolean> = {
  user: false,
  api_key: false,
  caller: false,
  iam_token: false,
  on_behalf_of: false,
  generation: true,
  project: true,
  project_group: true,
  agent: true,
  trigger: true,
  eval: true,
  decider: true,
  ingestion_rule: true,
  memory_rule: true,
  playbook_version: true,
};

const capOf = (args: {
  principal: DeniedPrincipal;
  sets: PolicySets;
}): AssertionCap => {
  return {
    by: NAMED_THROUGH_ASSERTION[args.principal.type]
      ? args.principal
      : ASSERTION,
    sets: args.sets,
  };
};

/**
 * Whose authority a tool call carries in its assertion. `caller` is the
 * request's own resolved credential, narrowings included; without one, or
 * under `run_as: agent`, the authority the turn's calls run under is resolved
 * (`turnAuthority`). A sender with neither sends nothing
 * (`meterToolExecution`). `agentAuthority` is the calling agent's, as every
 * `builtin` call of the turn is held to its caps.
 */
export type AssertionSender = {
  caller?: SenderCredential;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
};

const credentialOf = async (
  sender: AssertionSender
): Promise<SenderCredential | undefined> => {
  if (sender.caller && sender.agentAuthority?.runAs !== 'agent') {
    return sender.caller;
  }
  return authUserUnder(turnAuthority(sender));
};

/** The principal and `tool_context` layer a callback carries on. */
const chainOf = (
  credential: SenderCredential | undefined
): Pick<AssertionAuthority, 'principal' | 'toolContext'> => {
  const principal = credential ? actsForOf(credential) : null;
  const toolContext = credential?.toolContextLayer;
  return {
    ...(principal ? { principal } : {}),
    ...(toolContext ? { toolContext } : {}),
  };
};

/**
 * The authority a call's assertion seals: the sender's credential in the
 * tool's project ∩ the agent's caps. A sender with no credential, or
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
  const credentialCaps = credential
    ? await credential.getLabeledPolicies(projectPublicId)
    : [];
  log(
    'resolveSenderAuthority: project=%s credential=%s',
    projectPublicId,
    credentialCaps.length > 0
  );
  const agentCaps = (sender.agentAuthority?.caps ?? []).map(
    ({ by, policy }) => {
      return { principal: by, sets: [[policy]] };
    }
  );
  return {
    caps: [
      ...(credentialCaps.length > 0
        ? credentialCaps
        : [{ principal: ASSERTION, sets: NOTHING }]),
      ...agentCaps,
    ].map(capOf),
    ...chainOf(credential),
  };
};
