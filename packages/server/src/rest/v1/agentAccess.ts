/**
 * The agent's binding of the shared item-route preamble.
 *
 * Agents were the first module moved off the project-level probe (#1336) and
 * the shape held for every other one, so the decision itself now lives in
 * `resourceAccess.ts`. What stays here is only what is agent-specific: the
 * accessor the scope comes from, the SRN's type, and the noun a `404` names.
 */
import { agents } from 'src/lib/agentAccessor';

import { makeItemRouteAuthorizer } from './resourceAccess';

const agentAccess = makeItemRouteAuthorizer({
  findScope: agents.findScope,
  resourceType: 'agent',
  param: 'agent_id',
  label: 'Agent',
});

/** `Get` / `List` on one agent: a refusal is indistinguishable from absence. */
export const authorizeAgentRead = agentAccess.authorizeRead;

/** Anything that changes an agent or runs it: a refusal says so. */
export const authorizeAgentWrite = agentAccess.authorizeWrite;
