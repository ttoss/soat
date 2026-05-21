import createDebug from 'debug';

import { createAgent, deleteAgent, updateAgent } from '../agents';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableArray,
  toNullableNumber,
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:agents');

const SCHEMA_NAME = 'AgentResourceProperties';
const RESOURCE_LABEL = 'agent';

// ── Property validation ──────────────────────────────────────────────────

const validateAgentProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { properties, basePath, forUpdate } = args;
  if (!isObjectRecord(properties)) {
    return [
      { path: basePath, message: 'Agent `properties` must be an object' },
    ];
  }

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

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const agentsFormationModule: FormationModule = {
  resourceType: 'agent',

  validateProperties: ({ properties, basePath }) => {
    return validateAgentProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateAgentProperties({
      properties,
      basePath: 'resources.<agent>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const result = await createAgent({
      projectId,
      aiProviderId: properties.ai_provider_id as string,
      name: toOptionalString(properties.name) ?? undefined,
      instructions: toOptionalString(properties.instructions),
      model: toOptionalString(properties.model),
      toolIds: toNullableArray<string>(properties.tool_ids) ?? undefined,
      maxSteps: toNullableNumber(properties.max_steps) ?? undefined,
      toolChoice: toNullableObject(properties.tool_choice) ?? undefined,
      stopConditions:
        toNullableArray<object>(properties.stop_conditions) ?? undefined,
      activeToolIds:
        toNullableArray<string>(properties.active_tool_ids) ?? undefined,
      stepRules: toNullableArray<object>(properties.step_rules) ?? undefined,
      boundaryPolicy: toNullableObject(properties.boundary_policy) ?? undefined,
      temperature: toNullableNumber(properties.temperature) ?? undefined,
      knowledgeConfig:
        toNullableObject(properties.knowledge_config) ?? undefined,
    });

    if (result === 'ai_provider_not_found') {
      throw new Error(`AI provider not found: ${properties.ai_provider_id}`);
    }

    log(
      'created agent from formation: projectId=%d agentId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateAgentProperties({
      properties,
      basePath: 'resources.<agent>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const result = await updateAgent({
      id: physicalResourceId,
      aiProviderId: toOptionalString(properties.ai_provider_id),
      name: toNullableString(properties.name),
      instructions: toNullableString(properties.instructions),
      model: toNullableString(properties.model),
      toolIds: toNullableArray<string>(properties.tool_ids),
      maxSteps: toNullableNumber(properties.max_steps),
      toolChoice: toNullableObject(properties.tool_choice),
      stopConditions: toNullableArray<object>(properties.stop_conditions),
      activeToolIds: toNullableArray<string>(properties.active_tool_ids),
      stepRules: toNullableArray<object>(properties.step_rules),
      boundaryPolicy: toNullableObject(properties.boundary_policy),
      temperature: toNullableNumber(properties.temperature),
      knowledgeConfig: toNullableObject(properties.knowledge_config),
    });

    if (result === 'not_found') {
      throw new Error(`Agent not found: ${physicalResourceId}`);
    }
    if (result === 'ai_provider_not_found') {
      throw new Error(`AI provider not found: ${properties.ai_provider_id}`);
    }
  },

  delete: async ({ physicalResourceId }) => {
    const result = await deleteAgent({ id: physicalResourceId });
    if (result === 'not_found') {
      throw new Error(`Agent not found: ${physicalResourceId}`);
    }
  },
};
