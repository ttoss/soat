import type { PolicyDocument } from '../iam';
import { validatePolicyActions } from '../iam';
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  updatePolicy,
} from '../policies';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

export const policiesFormationModule = defineFormationModule({
  resourceType: 'policy',
  // The policies routes gate on the `admin` role, not on a policy-grantable
  // action — a policy that granted `policies:CreatePolicy` to a non-admin would
  // otherwise make the formation path the weaker of the two, and a template
  // declaring a `*` policy plus an `api_key` carrying it is the escalation
  // #1181 reports.
  authorization: {
    srnResourceType: 'policy',
    create: 'policies:CreatePolicy',
    update: 'policies:UpdatePolicy',
    delete: 'policies:DeletePolicy',
    adminOnly: true,
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

  create: async ({ properties }) => {
    const result = await createPolicy({
      name: toOptionalString(properties.name) ?? undefined,
      description: toOptionalString(properties.description) ?? undefined,
      document: properties.document as PolicyDocument,
    });

    if ('invalid' in result) {
      throw new Error(
        `Policy document is invalid: ${result.errors.join(', ')}`
      );
    }

    return result;
  },

  update: async ({ properties, physicalResourceId }) => {
    const result = await updatePolicy({
      policyId: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toOptionalString(properties.description) ?? undefined,
      document: properties.document as PolicyDocument,
    });

    if ('invalid' in result) {
      throw new Error(
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
