import createDebug from 'debug';

import {
  denormalizeKnowledgeConfig,
  normalizeKnowledgeConfig,
} from '../agentKnowledge';
import { createAgent, deleteAgent, getAgent, updateAgent } from '../agents';
import type { AgentToolBinding } from '../agentToolBindings';
import { bindingsFromLegacyFields } from '../agentToolBindings';
import type { FormationModule, ValidationError } from '../formationsTypes';
import { validatePolicyActions } from '../iam';
import {
  normalizePropertyKeys,
  toNullableArray,
  toNullableNumber,
  toNullableObject,
  toNullableString,
  toNullableStringOrObject,
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

// `tool_bindings` is canonical; `tool_ids` is its deprecated shorthand — a
// template must pick one form (mirrors the REST exclusivity rule). Inline
// `tool` entries are rejected: templates declare a tool resource and
// reference it via `tool_id` instead.
const pushToolBindingErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  const { properties, basePath, errors } = args;
  if (properties.tool_bindings != null && properties.tool_ids != null) {
    errors.push({
      path: `${basePath}.tool_bindings`,
      message:
        '`tool_bindings` cannot be combined with the deprecated `tool_ids` field',
    });
  }
  if (!Array.isArray(properties.tool_bindings)) return;
  for (const [index, entry] of properties.tool_bindings.entries()) {
    if (isObjectRecord(entry) && entry.tool != null) {
      errors.push({
        path: `${basePath}.tool_bindings[${index}]`,
        message:
          'inline `tool` bindings are not supported in formation templates; declare a tool resource and reference it via `tool_id`',
      });
    }
  }
};

const validateAgentProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      { path: basePath, message: 'Agent `properties` must be an object' },
    ];
  }
  // Accept camelCase top-level keys (e.g. `aiProviderId`) like every other
  // formation module, normalizing to the snake_case the OpenAPI schema and the
  // property readers below expect.
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

  // A `boundary_policy` gates the agent's SOAT-native tool actions, so its
  // action strings must be real and enforceable — otherwise a mis-named `Deny`
  // silently no-ops and the boundary fails open. Validate the action names here
  // (only when it is shaped as a policy object); structural validation is
  // applied by the boundary evaluator at generation time.
  const boundaryPolicy = properties.boundary_policy;
  if (boundaryPolicy != null && isObjectRecord(boundaryPolicy)) {
    for (const message of validatePolicyActions(boundaryPolicy).errors) {
      errors.push({ path: `${basePath}.boundary_policy`, message });
    }
  }

  pushToolBindingErrors({ properties, basePath, errors });

  return errors;
};

// ── tool_bindings ↔ template shape ───────────────────────────────────────
//
// Binding entries are stored camelCase (internal convention) but declared and
// read snake_case in templates. Only `tool_id` entries are supported in
// formations (no inline `tool` — declare a tool resource instead), so the
// conversion enumerates known keys. Tool-call gating is owned by guardrails,
// which attach through `guardrail_ids`, not through the binding.

const parseFormationToolBindings = (
  value: unknown
): AgentToolBinding[] | null => {
  const entries = toNullableArray<Record<string, unknown>>(value);
  if (!entries) return null;
  return entries.map((entry): AgentToolBinding => {
    const binding: AgentToolBinding = {};
    if (typeof entry.tool_id === 'string') binding.toolId = entry.tool_id;
    return binding;
  });
};

const readFormationToolBindings = (
  bindings: AgentToolBinding[] | null
): Record<string, unknown>[] | null => {
  if (!bindings) return null;
  return bindings.map((binding) => {
    return {
      ...(binding.toolId !== undefined ? { tool_id: binding.toolId } : {}),
    };
  });
};

// A formation declares the agent's full desired state, so the binding list is
// always driven through the canonical `toolBindings` replace: an explicit
// `tool_bindings` wins, a declared `tool_ids` shorthand maps to bare bindings,
// and neither means "no tools".
const resolveFormationToolBindings = (
  properties: Record<string, unknown>
): AgentToolBinding[] | null => {
  if (properties.tool_bindings != null) {
    return parseFormationToolBindings(properties.tool_bindings);
  }
  return bindingsFromLegacyFields({
    toolIds: toNullableArray<string>(properties.tool_ids),
    tools: null,
  });
};

const toOptionalBoolean = (value: unknown): boolean | undefined => {
  return value != null ? Boolean(value) : undefined;
};

const toOptional = <T>(value: T | null | undefined): T | undefined => {
  return value ?? undefined;
};

// ── Module export ────────────────────────────────────────────────────────

const mapAgentProperties = (properties: Record<string, unknown>) => {
  return {
    aiProviderId: properties.ai_provider_id as string,
    name: toOptionalString(properties.name),
    instructions: toOptionalString(properties.instructions),
    model: toOptionalString(properties.model),
    toolBindings: toOptional(resolveFormationToolBindings(properties)),
    maxSteps: toOptional(toNullableNumber(properties.max_steps)),
    toolChoice: toOptional(toNullableStringOrObject(properties.tool_choice)),
    stopConditions: toOptional(
      toNullableArray<object>(properties.stop_conditions)
    ),
    activeToolIds: toOptional(
      toNullableArray<string>(properties.active_tool_ids)
    ),
    guardrailIds: toOptional(toNullableArray<string>(properties.guardrail_ids)),
    stepRules: toOptional(toNullableArray<object>(properties.step_rules)),
    boundaryPolicy: toOptional(toNullableObject(properties.boundary_policy)),
    temperature: toOptional(toNullableNumber(properties.temperature)),
    maxContextMessages: toOptional(
      toNullableNumber(properties.max_context_messages)
    ),
    singleSessionPerActor: toOptionalBoolean(
      properties.single_session_per_actor
    ),
    knowledgeConfig: toOptional(
      normalizeKnowledgeConfig(properties.knowledge_config)
    ),
    outputSchema: toOptional(toNullableObject(properties.output_schema)),
  };
};

const buildCreateAgentArgs = (args: {
  properties: Record<string, unknown>;
  projectId: number;
}) => {
  return {
    projectId: args.projectId,
    ...mapAgentProperties(args.properties),
  };
};

export const agentsFormationModule: FormationModule = {
  resourceType: 'agent',

  validateProperties: ({ properties, basePath }) => {
    return validateAgentProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateAgentProperties({
      properties: rawProperties,
      basePath: 'resources.<agent>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }
    const properties = normalizePropertyKeys(rawProperties);
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

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateAgentProperties({
      properties: rawProperties,
      basePath: 'resources.<agent>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = normalizePropertyKeys(rawProperties);
    await updateAgent({
      id: physicalResourceId,
      aiProviderId: toOptionalString(properties.ai_provider_id),
      name: toNullableString(properties.name),
      instructions: toNullableString(properties.instructions),
      model: toNullableString(properties.model),
      toolBindings: resolveFormationToolBindings(properties),
      maxSteps: toNullableNumber(properties.max_steps),
      toolChoice: toNullableStringOrObject(properties.tool_choice),
      stopConditions: toNullableArray<object>(properties.stop_conditions),
      activeToolIds: toNullableArray<string>(properties.active_tool_ids),
      guardrailIds: toNullableArray<string>(properties.guardrail_ids),
      stepRules: toNullableArray<object>(properties.step_rules),
      boundaryPolicy: toNullableObject(properties.boundary_policy),
      temperature: toNullableNumber(properties.temperature),
      maxContextMessages: toNullableNumber(properties.max_context_messages),
      singleSessionPerActor: toOptionalBoolean(
        properties.single_session_per_actor
      ),
      knowledgeConfig: normalizeKnowledgeConfig(properties.knowledge_config),
      outputSchema: toNullableObject(properties.output_schema),
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
        // Both views: the diff only compares keys the template declares, so a
        // template using either form converges against its own key.
        tool_bindings: readFormationToolBindings(agent.toolBindings),
        tool_ids: agent.toolIds,
        max_steps: agent.maxSteps,
        tool_choice: agent.toolChoice,
        stop_conditions: agent.stopConditions,
        active_tool_ids: agent.activeToolIds,
        guardrail_ids: agent.guardrailIds,
        step_rules: agent.stepRules,
        boundary_policy: agent.boundaryPolicy,
        temperature: agent.temperature,
        max_context_messages: agent.maxContextMessages,
        single_session_per_actor: agent.singleSessionPerActor,
        knowledge_config: denormalizeKnowledgeConfig(agent.knowledgeConfig),
        output_schema: agent.outputSchema,
      };
    } catch {
      return null;
    }
  },
};
