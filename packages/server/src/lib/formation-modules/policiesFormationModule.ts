import { DomainError } from '../../errors';
import type { PolicyDocument } from '../iam';
import {
  findAllowResourcesOutsideEveryProject,
  validatePolicyActions,
  validatePolicyDocument,
} from '../iam';
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

  // Every check that needs no project id runs at validate and plan time, so a
  // plan refuses what its apply would; the formation's own project is checked
  // on apply.
  extraChecks: ({ properties, basePath, errors }) => {
    const document = properties.document;
    if (document == null || !isObjectRecord(document)) return;
    const structural = validatePolicyDocument(document);
    const messages = structural.valid
      ? validatePolicyActions(document).errors
      : structural.errors;
    for (const message of messages) {
      errors.push({ path: `${basePath}.document`, message });
    }
    if (!structural.valid) return;
    for (const resource of findAllowResourcesOutsideEveryProject(
      document as PolicyDocument
    )) {
      errors.push({
        path: `${basePath}.document`,
        message: `Allow resource '${resource}' is outside the formation's project; name srn:<project_id>:<type>:<id>, or omit resource for every resource of the project.`,
      });
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
