import { db } from '../../db';
import {
  denormalizeKnowledgeConfig,
  normalizeKnowledgeConfig,
} from '../agentKnowledge';
import { createAgent, deleteAgent, getAgent, updateAgent } from '../agents';
import type { AgentToolBinding } from '../agentToolBindings';
import { bindingsFromLegacyFields } from '../agentToolBindings';
import { lookupProjectOwnerUserId } from '../formationsHelpers';
import type { ValidationError } from '../formationsTypes';
import { validatePolicyActions } from '../iam';
import { validateModelRouteExclusivity } from '../modelRoutes';
import {
  toNullableArray,
  toNullableNumber,
  toNullableObject,
  toNullableString,
  toNullableStringOrObject,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

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

/**
 * The pinned-provider vs model-route invariant, enforced with the same exported
 * rule the REST handlers use (`.claude/rules/modules.md`, Shared Business
 * Rules). A declaring template must name exactly one; an update that mentions
 * neither field leaves the stored binding untouched, so "neither" is only an
 * error when the template is declaring the agent's binding.
 */
const pushModelBindingErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
  forUpdate: boolean;
}): void => {
  const { properties, basePath, errors, forUpdate } = args;
  const declaresBinding =
    properties.ai_provider_id !== undefined ||
    properties.model_route_id !== undefined;
  if (forUpdate && !declaresBinding) return;

  const message = validateModelRouteExclusivity({
    modelRouteId: properties.model_route_id,
    aiProviderId: properties.ai_provider_id,
    model: properties.model,
  });
  if (message) errors.push({ path: basePath, message });
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

const mapAgentProperties = (properties: Record<string, unknown>) => {
  return {
    aiProviderId: toOptionalString(properties.ai_provider_id),
    modelRouteId: toOptionalString(properties.model_route_id),
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
    traceContentMode: toOptional(
      toNullableString(properties.trace_content_mode)
    ),
    knowledgeConfig: toOptional(
      normalizeKnowledgeConfig(properties.knowledge_config)
    ),
    outputSchema: toOptional(toNullableObject(properties.output_schema)),
  };
};

/**
 * The principal an apply is attributed to. A formation deploy has no request
 * user, so — exactly as trigger firings do — it resolves to the project's owning
 * identity, which keeps a formation-authored version indistinguishable in shape
 * from a REST-authored one rather than leaving history anonymous.
 */
const resolveApplyingPrincipal = async (args: {
  projectId: number;
}): Promise<number> => {
  return lookupProjectOwnerUserId(args.projectId);
};

/**
 * `update` receives only the physical resource id, so the project has to be
 * resolved from the agent itself before its owner can be looked up.
 */
const resolveApplyingPrincipalForAgent = async (
  agentPublicId: string
): Promise<number | undefined> => {
  const agent = await db.Agent.findOne({
    where: { publicId: agentPublicId },
    attributes: ['projectId'],
  });
  if (!agent) return undefined;
  return resolveApplyingPrincipal({ projectId: agent.projectId });
};

export const agentsFormationModule = defineFormationModule({
  resourceType: 'agent',

  extraChecks: ({ properties, basePath, forUpdate, errors }) => {
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
    pushModelBindingErrors({ properties, basePath, errors, forUpdate });
  },

  create: async ({ properties, projectId }) => {
    return createAgent({
      projectId,
      createdByUserId: await resolveApplyingPrincipal({ projectId }),
      ...mapAgentProperties(properties),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateAgent({
      id: physicalResourceId,
      createdByUserId:
        await resolveApplyingPrincipalForAgent(physicalResourceId),
      // Same semantics as a REST PATCH: an explicit `null` clears the binding,
      // an undeclared field leaves it alone. Switching an agent to a route
      // therefore declares `model_route_id` together with
      // `ai_provider_id: null`.
      aiProviderId: toNullableString(properties.ai_provider_id),
      modelRouteId: toNullableString(properties.model_route_id),
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
      traceContentMode: toNullableString(properties.trace_content_mode),
      knowledgeConfig: normalizeKnowledgeConfig(properties.knowledge_config),
      outputSchema: toNullableObject(properties.output_schema),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteAgent({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getAgent({ id: physicalResourceId });
  },

  // `knowledge_config` is stored normalized and read back denormalized, so this
  // view is a mapping rather than a plain field selection.
  read: (agent) => {
    return {
      ai_provider_id: agent.ai_provider_id,
      model_route_id: agent.model_route_id,
      name: agent.name,
      instructions: agent.instructions,
      model: agent.model,
      // Both views: the diff only compares keys the template declares, so a
      // template using either form converges against its own key.
      tool_bindings: agent.tool_bindings,
      tool_ids: agent.tool_ids,
      max_steps: agent.max_steps,
      tool_choice: agent.tool_choice,
      stop_conditions: agent.stop_conditions,
      active_tool_ids: agent.active_tool_ids,
      guardrail_ids: agent.guardrail_ids,
      step_rules: agent.step_rules,
      boundary_policy: agent.boundary_policy,
      temperature: agent.temperature,
      max_context_messages: agent.max_context_messages,
      single_session_per_actor: agent.single_session_per_actor,
      trace_content_mode: agent.trace_content_mode,
      knowledge_config: denormalizeKnowledgeConfig(agent.knowledge_config),
      output_schema: agent.output_schema,
    };
  },
});
