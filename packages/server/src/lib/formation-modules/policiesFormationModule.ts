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
import { findAllowResourcesOutsideProject } from '../policyProjectIds';
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

  // With the formation's project, plan refuses every Allow resource its apply
  // would; without one, only those outside every project.
  extraChecks: ({ properties, basePath, projectPublicId, errors }) => {
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
    const policy = document as PolicyDocument;
    const outside =
      projectPublicId === null
        ? findAllowResourcesOutsideEveryProject(policy)
        : findAllowResourcesOutsideProject({
            document: policy,
            projectPublicId,
          });
    const project = projectPublicId ?? '<project_id>';
    for (const resource of outside) {
      errors.push({
        path: `${basePath}.document`,
        message: `Allow resource '${resource}' is outside the formation's project; name srn:${project}:<type>:<id>, or omit resource for every resource of the project.`,
      });
    }
  },

  create: async ({ properties, projectId, actor }) => {
    const result = await createPolicy({
      project: {
        id: projectId,
        publicId: await findProjectPublicId({ id: projectId }),
      },
      name: toOptionalString(properties.name) ?? undefined,
      description: toOptionalString(properties.description) ?? undefined,
      document: properties.document as PolicyDocument,
      writerUnrestricted: actor.unrestricted,
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
      writerUnrestricted: actor.unrestricted,
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
