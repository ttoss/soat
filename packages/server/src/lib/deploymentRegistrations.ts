import { initAdmission } from './admission';
import { initBuiltinActionCatalog } from './builtinActionCatalog';
import { initFormationResourceTypes } from './formationsRegistry';
import { initIamRegistrations } from './iamRegistrations';
import { initMcpToolRegistrations } from './mcpToolRegistrations';

/**
 * Loads every deployment registration file, in every process that serves or
 * drains work: a worker without them would run writes no gate is asked about,
 * or resolve a tool unlike the API. Throws on any problem, which fails the boot.
 */
export const initDeploymentRegistrations = (): void => {
  // IAM modules first: the others declare actions only they may answer.
  initIamRegistrations();
  initMcpToolRegistrations();
  initBuiltinActionCatalog();
  initFormationResourceTypes();
  initAdmission();
};
