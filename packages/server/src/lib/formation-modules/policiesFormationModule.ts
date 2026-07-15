import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import type { PolicyDocument } from '../iam';
import { validatePolicyActions, validatePolicyDocument } from '../iam';
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  updatePolicy,
} from '../policies';
import {
  normalizePropertyKeys,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:policies');

const SCHEMA_NAME = 'PolicyResourceProperties';
const RESOURCE_LABEL = 'policy';

// ── Property validation ──────────────────────────────────────────────────

const validatePolicyProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Policy `properties` must be an object',
      },
    ];
  }

  const properties = normalizePropertyKeys(args.properties);
  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  // The `document` is an IAM policy — validate its action strings here so a
  // typo'd / nonexistent action is rejected at `validate-formation` time rather
  // than silently accepted and failing open at evaluation. Only run when the
  // document is shaped as a policy object; structural type errors are already
  // reported by pushFieldTypeErrors above.
  const document = properties.document;
  if (document != null && isObjectRecord(document)) {
    const structural = validatePolicyDocument(document);
    const semantic = structural.valid
      ? validatePolicyActions(document)
      : structural;
    for (const message of semantic.errors) {
      errors.push({ path: `${basePath}.document`, message });
    }
  }

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const policiesFormationModule: FormationModule = {
  resourceType: 'policy',

  validateProperties: ({ properties, basePath }) => {
    return validatePolicyProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties }) => {
    const errors = validatePolicyProperties({
      properties: rawProperties,
      basePath: 'resources.<policy>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

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

    log('created policy from formation: id=%s', result.id);
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validatePolicyProperties({
      properties: rawProperties,
      basePath: 'resources.<policy>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

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

    log('updated policy from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deletePolicy({ policyId: physicalResourceId });
    log('deleted policy from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const policy = await getPolicy({ policyId: physicalResourceId });
      if (!policy) return null;
      return {
        name: policy.name,
        description: policy.description,
        document: policy.document,
      };
    } catch {
      return null;
    }
  },
};
