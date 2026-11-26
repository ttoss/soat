import { db } from '../db';
import type { AgentAuthority } from './agentAuthority';
import type { SenderCredential } from './assertionSender';
import { assertGuardrailsExist } from './guardrails';
import type { ResourceIncludes } from './modelIncludes';
import { type Page, paginatedList } from './pagination';
import { isPlainObject } from './plainObject';
import { assertProjectAcceptsWork } from './projectPause';
import { projectScopeWhere } from './projectScope';
import { makeResourceAccessor } from './resourceAccessor';
import { type ReferenceReach, toolReferences } from './resourceReferences';
import { assertToolSecretUseAllowed } from './secretUse';
import type { ToolCallGuardrailMode } from './toolCallGuardrail';
import { carriedActionsOfTool } from './toolCarriedActions';
import {
  type CallableToolDefinition,
  callResolvedTool,
  type InlineToolDefinition,
  type SignedOffCall,
} from './toolsCall';
import { assertTrustedOutputAllowed } from './toolTrust';
import {
  type ToolUpdateArgs,
  validateToolDefinition,
  validateToolUpdate,
} from './toolWriteValidation';
import type { ToolCallAttribution } from './usageToolRecording';
import type { WorkAuthority } from './workAuthority';
import { assertWriterHolds, type Writer } from './writerRule';

// Re-exported so importers of `assertEphemeralTypeSupported` and
// `InlineToolDefinition` (agents.ts, pipelineTools.ts, agentToolResolver.ts)
// can import them from this module.
export {
  assertEphemeralTypeSupported,
  type CallableToolDefinition,
  type InlineToolDefinition,
} from './toolsCall';

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedTool = {
  id: string;
  project_id: string;
  type: string;
  name: string;
  description: string | null;
  parameters: object | null;
  execute: object | null;
  mcp: object | null;
  mcp_pins: Record<string, string> | null;
  actions: string[] | null;
  denied_actions: string[] | null;
  context_keys: string[] | null;
  preset_parameters: object | null;
  preset_parameters_by_action: object | null;
  pipeline: object | null;
  output_mapping: object | null;
  guardrail_ids: string[] | null;
  trusted_output: boolean;
  created_at: Date;
  updated_at: Date;
};

// ── Map Helpers ───────────────────────────────────────────────────────────

const getToolIncludes = (): ResourceIncludes => {
  return [{ model: db.Project, as: 'project' }];
};

type ToolRow = InstanceType<typeof db.Tool> & {
  project: InstanceType<typeof db.Project>;
};

export const tools = makeResourceAccessor<ToolRow>({
  model: () => {
    return db.Tool;
  },
  includes: getToolIncludes,
  label: 'Tool',
});

const mapTool = (tool: ToolRow): MappedTool => {
  return {
    id: tool.publicId,
    project_id: tool.project.publicId,
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute,
    mcp: tool.mcp,
    mcp_pins: tool.mcpPins,
    actions: tool.actions,
    denied_actions: tool.deniedActions,
    context_keys: tool.contextKeys,
    preset_parameters: tool.presetParameters,
    preset_parameters_by_action: tool.presetParametersByAction,
    pipeline: tool.pipeline,
    output_mapping: tool.outputMapping,
    guardrail_ids: tool.guardrailIds,
    trusted_output: tool.trustedOutput,
    created_at: tool.createdAt,
    updated_at: tool.updatedAt,
  };
};

// ── CRUD ──────────────────────────────────────────────────────────────────

export type CreateToolArgs = InlineToolDefinition & {
  projectId: number;
  guardrailIds?: string[] | null;
};

const nullify = <T>(value: T | undefined): T | null => {
  return value ?? null;
};

const buildToolConfigFields = (args: CreateToolArgs) => {
  return {
    description: nullify(args.description),
    parameters: nullify(args.parameters),
    execute: nullify(args.execute),
    mcp: nullify(args.mcp),
    actions: nullify(args.actions),
    deniedActions: nullify(args.deniedActions),
    contextKeys: nullify(args.contextKeys),
    presetParameters: nullify(args.presetParameters),
    presetParametersByAction: nullify(args.presetParametersByAction),
    pipeline: nullify(args.pipeline),
    outputMapping: nullify(args.outputMapping),
    guardrailIds: nullify(args.guardrailIds),
    trustedOutput: args.trustedOutput ?? false,
  };
};

const buildToolCreateAttributes = (args: CreateToolArgs) => {
  return {
    projectId: args.projectId,
    type: args.type ?? 'http',
    name: args.name,
    ...buildToolConfigFields(args),
  };
};

export const createTool = async (
  args: CreateToolArgs & { writer: Writer }
): Promise<MappedTool> => {
  await assertToolSecretUseAllowed({
    tool: args,
    projectId: args.projectId,
    isAllowed: args.writer.isAllowed,
  });
  await assertTrustedOutputAllowed({
    trustedOutput: args.trustedOutput,
    projectId: args.projectId,
    isAllowed: args.writer.isAllowed,
  });
  await validateToolDefinition({ definition: args, projectId: args.projectId });
  await assertWriterHolds({
    carrier: 'tools',
    writer: args.writer,
    projectId: args.projectId,
    carried: {
      actions: carriedActionsOfTool({
        type: args.type ?? 'http',
        mcp: args.mcp,
        actions: args.actions,
        pipeline: args.pipeline,
      }),
    },
  });
  await assertGuardrailsExist({
    guardrailIds: args.guardrailIds,
    projectId: args.projectId,
  });

  const tool = await db.Tool.create(buildToolCreateAttributes(args));

  return mapTool(await tools.reload(tool));
};

export const listTools = async (args: {
  projectIds?: number[];
  limit?: number;
  cursor?: string;
}): Promise<Page<MappedTool>> => {
  const where: Record<string, unknown> = {};
  Object.assign(where, projectScopeWhere({ projectIds: args.projectIds }));

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds },
    where,
    order: [['createdAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Tool.findAll({
        where: pageWhere,
        include: getToolIncludes(),
        order,
        limit,
      });
    },
    map: (t) => {
      return mapTool(t as ToolRow);
    },
  });
};

export const getTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedTool> => {
  return mapTool(await tools.getByPublicId(args));
};

const buildToolUpdates = (args: {
  type?: string;
  name?: string;
  description?: string | null;
  parameters?: object | null;
  execute?: object | null;
  mcp?: object | null;
  actions?: string[] | null;
  deniedActions?: string[] | null;
  contextKeys?: string[] | null;
  presetParameters?: object | null;
  presetParametersByAction?: object | null;
  pipeline?: object | null;
  outputMapping?: object | null;
  guardrailIds?: string[] | null;
  trustedOutput?: boolean;
}): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  const scalarFields = [
    'type',
    'name',
    'description',
    'parameters',
    'execute',
    'mcp',
    'actions',
    'deniedActions',
    'contextKeys',
    'presetParameters',
    'presetParametersByAction',
    'pipeline',
    'outputMapping',
    'guardrailIds',
    'trustedOutput',
  ] as const;
  for (const field of scalarFields) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  return updates;
};

const mcpUrl = (mcp: unknown): string | null => {
  return isPlainObject(mcp) && typeof mcp.url === 'string' ? mcp.url : null;
};

/**
 * Pins are cleared on request or for another server, never by re-sending an
 * unchanged `mcp`, which every formation apply does: a deploy must not accept
 * drift silently.
 */
const clearsMcpPins = (args: {
  args: ToolUpdateArgs;
  current: unknown;
}): boolean => {
  if (args.args.mcpPins === null) return true;
  return (
    args.args.mcp !== undefined &&
    mcpUrl(args.args.mcp) !== mcpUrl(args.current)
  );
};

export const updateTool = async (
  args: ToolUpdateArgs & { writer: Writer }
): Promise<MappedTool> => {
  const tool = await tools.getByPublicId(args);

  await assertToolSecretUseAllowed({
    tool: args,
    projectId: tool.projectId,
    isAllowed: args.writer.isAllowed,
  });
  await assertTrustedOutputAllowed({
    trustedOutput: args.trustedOutput,
    projectId: tool.projectId,
    isAllowed: args.writer.isAllowed,
  });

  await validateToolUpdate({ args, tool });
  // The tool as it stands after the write, so an edit to any of its fields is checked.
  await assertWriterHolds({
    carrier: 'tools',
    writer: args.writer,
    projectId: tool.projectId,
    carried: {
      actions: carriedActionsOfTool({
        type: args.type ?? tool.type,
        mcp: args.mcp === undefined ? tool.mcp : args.mcp,
        actions: args.actions === undefined ? tool.actions : args.actions,
        pipeline: args.pipeline === undefined ? tool.pipeline : args.pipeline,
      }),
    },
  });
  await assertGuardrailsExist({
    guardrailIds: args.guardrailIds,
    projectId: tool.projectId,
  });

  await tool.update({
    ...buildToolUpdates(args),
    ...(clearsMcpPins({ args, current: tool.mcp }) ? { mcpPins: null } : {}),
  });

  return mapTool(await tools.reload(tool));
};

// ── Call ──────────────────────────────────────────────────────────────────

// The call path reads camelCase but `mapTool` emits the wire's snake_case.
// Converted explicitly: passing the wire object straight through resolves every
// camelCase field to undefined.
const toCallableTool = (tool: MappedTool): CallableToolDefinition => {
  return {
    name: tool.name,
    type: tool.type,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute,
    mcp: tool.mcp,
    actions: tool.actions,
    deniedActions: tool.denied_actions,
    contextKeys: tool.context_keys,
    presetParameters: tool.preset_parameters,
    presetParametersByAction: tool.preset_parameters_by_action,
    pipeline: tool.pipeline,
    outputMapping: tool.output_mapping,
  };
};

// A thin DB-backed wrapper around `callResolvedTool` (toolsCall.ts), which
// holds the actual per-type dispatch logic.
export const callTool = async (args: {
  /** The project that references the tool; also where the call is metered. */
  projectId: number;
  /** Whether the reference may be a tool another project shares with it. */
  reach: ReferenceReach;
  /**
   * Where the call is metered and gated when that is not `projectId`: a
   * pipeline step resolves in the pipeline's project but is still its
   * caller's work.
   */
  callerProjectId?: number;
  id: string;
  /**
   * Whether a guardrail gate has already adjudicated this call — see
   * {@link ToolCallGuardrailMode}. Required so no dispatch path can reach a
   * tool without stating it.
   */
  guardrails: ToolCallGuardrailMode;
  action?: string;
  input?: Record<string, unknown>;
  authority: WorkAuthority | null;
  remainingDepth?: number;
  // Forwarded to an HTTP tool as the `Idempotency-Key` request header (D7),
  // so a redelivered orchestration node call can be deduped downstream.
  idempotencyKey?: string;
  // An orchestration `tool`/`poll` node passes the run's bag, so a tool reached
  // with no agent in between still resolves its `{{context:}}` tokens. A
  // direct `POST /tools/{id}/call` passes none.
  toolContext?: Record<string, string>;
  /**
   * Who the call is metered against. Required so every dispatch site states
   * the ids it holds rather than dropping them by omission.
   */
  attribution: ToolCallAttribution;
  /** See {@link SignedOffCall}. */
  signedOff?: SignedOffCall;
  /** The calling agent's `policy_ids`, held over every `builtin` action. */
  agentAuthority?: AgentAuthority;
  /** The request's resolved credential, when the call is made in one. */
  caller?: SenderCredential;
  /** The calling work's cancellation; the call stops when it aborts. */
  abortSignal?: AbortSignal;
}): Promise<unknown> => {
  const referenced = await toolReferences.find({
    id: args.id,
    projectId: args.projectId,
    reach: args.reach,
  });
  if (!referenced) throw tools.notFound(args.id);
  const toolInstance = await tools.reload(referenced);
  const foundTool = mapTool(toolInstance);

  return callResolvedTool({
    tool: toCallableTool(foundTool),
    toolProjectId: toolInstance.projectId,
    callerProjectId: args.callerProjectId ?? args.projectId,
    guardrails: args.guardrails,
    toolPublicId: foundTool.id,
    toolGuardrailIds: foundTool.guardrail_ids,
    action: args.action,
    input: args.input,
    authority: args.authority,
    remainingDepth: args.remainingDepth,
    idempotencyKey: args.idempotencyKey,
    toolContext: args.toolContext,
    attribution: args.attribution,
    signedOff: args.signedOff,
    agentAuthority: args.agentAuthority,
    caller: args.caller,
    abortSignal: args.abortSignal,
  });
};

/**
 * {@link callTool} for a call that is new work in its own right — the direct
 * `POST /tools/{id}/call`, a trigger firing — refused while the calling
 * project is paused. The calls a generation, a run node or a scorer makes are
 * the work of something already admitted, so they go through `callTool` and
 * stop at that owner's own checkpoint.
 */
export const startToolCall = async (
  args: Parameters<typeof callTool>[0]
): Promise<unknown> => {
  await assertProjectAcceptsWork({ projectId: args.projectId });
  return callTool(args);
};
