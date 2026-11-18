import { DomainError } from '../../errors';
import { parseDeciderQuestions } from '../deciderQuestions';
import {
  createDecider,
  deciderBackendNamingError,
  deleteDecider,
  getDecider,
  updateDecider,
} from '../deciders';
import {
  toNullableArray,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const decidersFormationModule = defineFormationModule({
  resourceType: 'decider',
  authorization: {
    srnResourceType: 'decider',
    create: 'deciders:CreateDecider',
    update: 'deciders:UpdateDecider',
    delete: 'deciders:DeleteDecider',
  },

  // The questions are checked by the validator the route uses.
  extraChecks: ({ properties, basePath, forUpdate, errors }) => {
    const namingError = deciderBackendNamingError({
      namesAgent: properties.agent_id != null,
      namesTool: properties.tool_id != null,
      forUpdate,
    });
    if (namingError) errors.push({ path: basePath, message: namingError });

    if (properties.questions === undefined) return;
    try {
      parseDeciderQuestions(properties.questions);
    } catch (error) {
      errors.push({
        path: `${basePath}.questions`,
        message: error instanceof DomainError ? error.message : String(error),
      });
    }
  },

  create: ({ properties, projectId, actor }) => {
    return createDecider({
      projectId,
      createdBy: actor.author,
      writer: actor,
      name: properties.name,
      description: toNullableString(properties.description),
      agentId: properties.agent_id,
      toolId: properties.tool_id,
      questions: properties.questions,
      policyIds: toNullableArray<string>(properties.policy_ids),
    });
  },

  update: ({ properties, physicalResourceId, actor }) => {
    return updateDecider({
      id: physicalResourceId,
      createdBy: actor.author,
      writer: actor,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      agentId: properties.agent_id,
      toolId: properties.tool_id,
      questions: properties.questions,
      policyIds: toNullableArray<string>(properties.policy_ids),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteDecider({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getDecider({ id: physicalResourceId });
  },
});
