/**
 * What a deployment registers at boot, read by every process that serves its
 * requests or runs its work: the API and the standalone worker load the same
 * registrations, so a tool resolves alike on both. Any problem throws.
 */
import { initBuiltinActionCatalog } from './builtinActionCatalog';
import { initFormationResourceTypes } from './formationsRegistry';
import { initIamRegistrations } from './iamRegistrations';
import { initMcpToolRegistrations } from './mcpToolRegistrations';

export const initDeploymentRegistrations = (): void => {
  // IAM modules first: the others declare actions only they may answer.
  initIamRegistrations();
  initMcpToolRegistrations();
  initBuiltinActionCatalog();
  initFormationResourceTypes();
};
