import { DomainError } from '../../errors';
import type { PolicyDocument } from '../iam';
import { validatePolicyActions } from '../iam';
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  updatePolicy,
} from '../policies';
import { findProjectPublicId } from '../projects';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

export const policiesFormationModule = defineFormationModule({
  resourceType: 'policy',
  // A project policy, authorized as `POST /policies` with a project: its
  // `Allow` statements stay inside the project, and attaching it anywhere
  // still needs the attacher's grants.
  authorization: {
    srnResourceType: 'policy',
    create: 'policies:CreatePolicy',
    update: 'policies:UpdatePolicy',
    delete: 'policies:DeletePolicy',
  },

  // Only the semantic action-name check — structure is validated downstream.
  // A typo'd action rejected here fails at `validate-formation` time rather
  // than silently failing open at evaluation.
  extraChecks: ({ properties, basePath, errors }) => {
    const document = properties.document;
    if (document == null || !isObjectRecord(document)) return;
    for (const message of validatePolicyActions(document).errors) {
      errors.push({ path: `${basePath}.document`, message });
    }
  },

  create: async ({ properties, projectId }) => {
    const result = await createPolicy({
      project: {
        id: projectId,
        publicId: await findProjectPublicId({ id: projectId }),
      },
      name: toOptionalString(properties.name) ?? undefined,
      description: toOptionalString(properties.description) ?? undefined,
      document: properties.document as PolicyDocument,
    });

    if ('invalid' in result) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Policy document is invalid: ${result.errors.join(', ')}`
      );
    }

    return result;
  },

  update: async ({ properties, physicalResourceId, actor }) => {
    const result = await updatePolicy({
      policyId: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toOptionalString(properties.description) ?? undefined,
      document: properties.document as PolicyDocument,
      writerPolicies: actor.getPolicies,
    });

    if ('invalid' in result) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Policy document is invalid: ${result.errors.join(', ')}`
      );
    }
  },

  remove: ({ physicalResourceId }) => {
    return deletePolicy({ policyId: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getPolicy({ policyId: physicalResourceId });
  },
});
