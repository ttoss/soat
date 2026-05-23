import createDebug from 'debug';

import { createAgent, deleteAgent, getAgent, updateAgent } from '../agents';
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

const buildCreateAgentArgs = (args: {
  properties: Record<string, unknown>;
  projectId: number;
}) => {
  return {
    projectId: args.projectId,
    aiProviderId: args.properties.ai_provider_id as string,
    name: toOptionalString(args.properties.name),
    instructions: toOptionalString(args.properties.instructions),
    model: toOptionalString(args.properties.model),
    toolIds: toNullableArray<string>(args.properties.tool_ids) ?? undefined,
    maxSteps: toNullableNumber(args.properties.max_steps) ?? undefined,
    toolChoice: toNullableObject(args.properties.tool_choice) ?? undefined,
    stopConditions:
      toNullableArray<object>(args.properties.stop_conditions) ?? undefined,
    activeToolIds:
      toNullableArray<string>(args.properties.active_tool_ids) ?? undefined,
    stepRules: toNullableArray<object>(args.properties.step_rules) ?? undefined,
    boundaryPolicy:
      toNullableObject(args.properties.boundary_policy) ?? undefined,
    temperature: toNullableNumber(args.properties.temperature) ?? undefined,
    knowledgeConfig:
      toNullableObject(args.properties.knowledge_config) ?? undefined,
  };
};

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
    const result = await createAgent(
      buildCreateAgentArgs({ properties, projectId })
    );
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

    await updateAgent({
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
  },

  delete: async ({ physicalResourceId }) => {
    await deleteAgent({ id: physicalResourceId });
  },

  read: async ({ physicalResourceId }) => {
    try {
      const agent = await getAgent({ id: physicalResourceId });
      return {
        ai_provider_id: agent.aiProviderId,
        name: agent.name,
        instructions: agent.instructions,
        model: agent.model,
        tool_ids: agent.toolIds,
        max_steps: agent.maxSteps,
        tool_choice: agent.toolChoice,
        stop_conditions: agent.stopConditions,
        active_tool_ids: agent.activeToolIds,
        step_rules: agent.stepRules,
        boundary_policy: agent.boundaryPolicy,
        temperature: agent.temperature,
        knowledge_config: agent.knowledgeConfig,
      };
    } catch {
      return null;
    }
  },
};
