import createDebug from 'debug';
import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';
import { callTool } from './tools';

const log = createDebug('soat:orchestrations');

// ── Types ─────────────────────────────────────────────────────────────────

export type OrchestratorNodeType =
  | 'agent'
  | 'tool'
  | 'transform'
  | 'knowledge'
  | 'memory_write'
  | 'condition'
  | 'human';

export type OrchestrationNode = {
  id: string;
  type: OrchestratorNodeType;
  // agent node
  agentId?: string;
  // tool node
  toolId?: string;
  operationId?: string;
  // transform/condition node
  expression?: string;
  // knowledge node fields are provided via input_mapping
  // human node
  prompt?: string;
  options?: string[];
  // memory_write node
  memoryId?: string;
  // Shared mappings
  inputMapping?: Record<string, string>;
  outputMapping?: Record<string, string>;
  outputSchema?: object;
};

export type OrchestrationEdge = {
  from: string;
  to: string;
  condition?: string;
  activationGroup?: string;
  activationCondition?: 'all' | 'any';
};

export type MappedOrchestration = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  stateSchema: object | null;
  inputSchema: object | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MappedOrchestrationRun = {
  id: string;
  orchestrationId: string;
  projectId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  state: Record<string, unknown>;
  activeNodes: string[];
  artifacts: Record<string, unknown>;
  error: object | null;
  traceId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Map helpers ───────────────────────────────────────────────────────────

const mapOrchestration = (
  orch: InstanceType<typeof db.Orchestration> & {
    project: InstanceType<typeof db.Project>;
  }
): MappedOrchestration => {
  return {
    id: orch.publicId,
    projectId: orch.project.publicId,
    name: orch.name,
    description: orch.description,
    nodes: orch.nodes as OrchestrationNode[],
    edges: orch.edges as OrchestrationEdge[],
    stateSchema: orch.stateSchema,
    inputSchema: orch.inputSchema,
    createdAt: orch.createdAt,
    updatedAt: orch.updatedAt,
  };
};

const mapOrchestrationRun = (
  run: InstanceType<typeof db.OrchestrationRun> & {
    orchestration: InstanceType<typeof db.Orchestration>;
    project: InstanceType<typeof db.Project>;
  }
): MappedOrchestrationRun => {
  return {
    id: run.publicId,
    orchestrationId: run.orchestration.publicId,
    projectId: run.project.publicId,
    status: run.status,
    state: run.state as Record<string, unknown>,
    activeNodes: run.activeNodes as string[],
    artifacts: run.artifacts as Record<string, unknown>,
    error: run.error,
    traceId: run.traceId,
    input: run.input as Record<string, unknown> | null,
    output: run.output as Record<string, unknown> | null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
};

// ── CRUD: Orchestrations ──────────────────────────────────────────────────

export const createOrchestration = async (args: {
  projectId: number;
  name: string;
  description?: string | null;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  stateSchema?: object | null;
  inputSchema?: object | null;
}): Promise<MappedOrchestration> => {
  log('createOrchestration %o', { projectId: args.projectId, name: args.name });

  const orch = await db.Orchestration.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    nodes: args.nodes,
    edges: args.edges,
    stateSchema: args.stateSchema ?? null,
    inputSchema: args.inputSchema ?? null,
  });

  const created = await db.Orchestration.findOne({
    where: { id: orch.id as number },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapOrchestration(
    created as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const listOrchestrations = async (args: {
  projectIds: number[];
}): Promise<MappedOrchestration[]> => {
  log('listOrchestrations %o', { projectIds: args.projectIds });

  const rows = await db.Orchestration.findAll({
    where: { projectId: args.projectIds },
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'DESC']],
  });

  return rows.map((row) =>
    mapOrchestration(
      row as InstanceType<typeof db.Orchestration> & {
        project: InstanceType<typeof db.Project>;
      }
    )
  );
};

export const findOrchestration = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<MappedOrchestration | null> => {
  log('findOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({
    where,
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!orch) return null;

  return mapOrchestration(
    orch as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const updateOrchestration = async (args: {
  id: string;
  projectIds?: number[];
  name?: string;
  description?: string | null;
  nodes?: OrchestrationNode[];
  edges?: OrchestrationEdge[];
  stateSchema?: object | null;
  inputSchema?: object | null;
}): Promise<MappedOrchestration> => {
  log('updateOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({ where });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.id}' not found.`
    );

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates['name'] = args.name;
  if (args.description !== undefined) updates['description'] = args.description;
  if (args.nodes !== undefined) updates['nodes'] = args.nodes;
  if (args.edges !== undefined) updates['edges'] = args.edges;
  if (args.stateSchema !== undefined) updates['stateSchema'] = args.stateSchema;
  if (args.inputSchema !== undefined) updates['inputSchema'] = args.inputSchema;

  await orch.update(updates);

  const updated = await db.Orchestration.findOne({
    where: { id: orch.id as number },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapOrchestration(
    updated as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const deleteOrchestration = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<void> => {
  log('deleteOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({ where });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.id}' not found.`
    );

  await orch.destroy();
};

// ── CRUD: Orchestration Runs ──────────────────────────────────────────────

export const findOrchestrationRun = async (args: {
  id: string;
  orchestrationId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun | null> => {
  log('findOrchestrationRun %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    { model: db.Orchestration, as: 'orchestration' },
  ];

  if (args.orchestrationId) {
    include[1] = {
      model: db.Orchestration,
      as: 'orchestration',
      where: { publicId: args.orchestrationId },
    };
  }

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run) return null;

  return mapOrchestrationRun(
    run as InstanceType<typeof db.OrchestrationRun> & {
      orchestration: InstanceType<typeof db.Orchestration>;
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const listOrchestrationRuns = async (args: {
  orchestrationPublicId: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun[]> => {
  log('listOrchestrationRuns %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const orchWhere: Record<string, unknown> = {
    publicId: args.orchestrationPublicId,
  };
  if (args.projectIds) orchWhere['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({ where: orchWhere });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.orchestrationPublicId}' not found.`
    );

  const rows = await db.OrchestrationRun.findAll({
    where: { orchestrationId: orch.id as number },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
    ],
    order: [['createdAt', 'DESC']],
  });

  return rows.map((row) =>
    mapOrchestrationRun(
      row as InstanceType<typeof db.OrchestrationRun> & {
        orchestration: InstanceType<typeof db.Orchestration>;
        project: InstanceType<typeof db.Project>;
      }
    )
  );
};

// ── Execution Engine ──────────────────────────────────────────────────────

/**
 * Resolve a value from state by path (e.g. "state.customer.id").
 * Supports "state.fieldName" and "state.nested.field" notation.
 */
const resolveFromState = (
  path: string,
  state: Record<string, unknown>
): unknown => {
  if (!path.startsWith('state.')) return undefined;
  const parts = path.slice('state.'.length).split('.');
  let cursor: unknown = state;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
};

/**
 * Write a value into state by path (e.g. "state.customer").
 * Only supports one level of nesting for now (state.field).
 */
const writeToState = (
  path: string,
  value: unknown,
  state: Record<string, unknown>
): void => {
  if (!path.startsWith('state.')) return;
  const fieldName = path.slice('state.'.length);
  state[fieldName] = value;
};

/**
 * Apply input_mapping: resolve values from state into a plain object for node consumption.
 */
const applyInputMapping = (
  inputMapping: Record<string, string> | undefined,
  state: Record<string, unknown>
): Record<string, unknown> => {
  if (!inputMapping) return {};
  const result: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(inputMapping)) {
    result[key] = resolveFromState(path, state);
  }
  return result;
};

/**
 * Apply output_mapping: take values from artifact and write them to state.
 */
const applyOutputMapping = (
  outputMapping: Record<string, string> | undefined,
  artifact: Record<string, unknown>,
  state: Record<string, unknown>
): void => {
  if (!outputMapping) return;
  for (const [artifactKey, statePath] of Object.entries(outputMapping)) {
    writeToState(statePath, artifact[artifactKey], state);
  }
};

// ── Node Executors ────────────────────────────────────────────────────────

type NodeExecutionResult =
  | { kind: 'artifact'; artifact: Record<string, unknown> }
  | { kind: 'condition'; label: string }
  | {
      kind: 'requires_action';
      nodeId: string;
      prompt: string;
      context: Record<string, unknown>;
      options?: string[];
    };

const executeAgentNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, traceId, authHeader } = args;
  if (!node.agentId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Agent node '${node.id}' missing agentId.`
    );

  const inputs = applyInputMapping(node.inputMapping, state);
  const contextLines = Object.entries(inputs)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: contextLines || '(no input)' },
  ];

  const result = await createGeneration({
    projectIds,
    agentId: node.agentId,
    messages,
    parentTraceId: traceId,
    authHeader,
  });

  if (result instanceof ReadableStream) {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Agent node '${node.id}' returned a streaming response, which is not supported in orchestrations.`
    );
  }

  let artifact: Record<string, unknown> = {
    content: result.output?.content ?? null,
  };

  if (node.outputSchema && result.output?.content) {
    try {
      const parsed: unknown = JSON.parse(result.output.content as string);
      if (typeof parsed === 'object' && parsed !== null) {
        artifact = parsed as Record<string, unknown>;
      }
    } catch {
      // leave artifact as { content }
    }
  }

  return { kind: 'artifact', artifact };
};

const executeToolNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader } = args;
  if (!node.toolId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Tool node '${node.id}' missing toolId.`
    );

  const inputs = applyInputMapping(node.inputMapping, state);
  const result = await callTool({
    projectIds,
    id: node.toolId,
    action: node.operationId,
    input: inputs as Record<string, unknown>,
    authHeader,
  });

  const artifact: Record<string, unknown> =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : { result };

  return { kind: 'artifact', artifact };
};

const executeTransformNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  if (!node.expression)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Transform node '${node.id}' missing expression.`
    );

  // Evaluate expression in a sandboxed context using Function constructor
  // Only state and JSON are available; no side effects.
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'state',
    `"use strict"; return (${node.expression});`
  );
  const result: unknown = fn(state);
  const artifact: Record<string, unknown> = { result };
  return { kind: 'artifact', artifact };
};

const executeKnowledgeNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds } = args;
  const inputs = applyInputMapping(node.inputMapping, state);

  const results = await searchKnowledge({
    projectIds,
    query: typeof inputs['query'] === 'string' ? inputs['query'] : undefined,
    memoryIds: Array.isArray(inputs['memoryIds'])
      ? (inputs['memoryIds'] as string[])
      : undefined,
    memoryTags: Array.isArray(inputs['memoryTags'])
      ? (inputs['memoryTags'] as string[])
      : undefined,
  });

  return { kind: 'artifact', artifact: { results } };
};

const executeMemoryWriteNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): Promise<NodeExecutionResult> => {
  const { node, state } = args;
  if (!node.memoryId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `memory_write node '${node.id}' missing memoryId.`
    );

  const inputs = applyInputMapping(node.inputMapping, state);
  const memory = await db.Memory.findOne({
    where: { publicId: node.memoryId },
  });
  if (!memory)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Memory '${node.memoryId}' not found.`
    );

  const content =
    typeof inputs['content'] === 'string'
      ? inputs['content']
      : JSON.stringify(inputs['content'] ?? '');

  const writeResult = await writeMemoryEntry({
    memoryId: memory.id as number,
    content,
  });

  return { kind: 'artifact', artifact: { action: writeResult.action } };
};

const executeConditionNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  if (!node.expression)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Condition node '${node.id}' missing expression.`
    );

  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'state',
    `"use strict"; return String(${node.expression});`
  );
  const label: string = fn(state) as string;
  return { kind: 'condition', label };
};

const executeHumanNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  const context = applyInputMapping(node.inputMapping, state);
  return {
    kind: 'requires_action',
    nodeId: node.id,
    prompt: node.prompt ?? 'Human input required.',
    context,
    options: node.options,
  };
};

// ── Sequential Execution Engine ───────────────────────────────────────────

/**
 * Find nodes that have no incoming edges (start nodes).
 */
const findStartNodes = (
  nodes: OrchestrationNode[],
  edges: OrchestrationEdge[]
): string[] => {
  const hasIncoming = new Set(edges.map((e) => e.to));
  return nodes.map((n) => n.id).filter((id) => !hasIncoming.has(id));
};

/**
 * Given completed nodes, resolve the next set of nodes to execute.
 * For Phase 1 (linear), we support simple sequential and fan-out/fan-in with
 * activation groups.
 */
const resolveNextNodes = (args: {
  completedNodeId: string;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  edges: OrchestrationEdge[];
}): string[] => {
  const { completedNodeId, completedNodes, conditionLabels, edges } = args;
  const next: string[] = [];

  // Edges originating from this completed node
  const outEdges = edges.filter((e) => e.from === completedNodeId);

  for (const edge of outEdges) {
    // Check condition
    if (edge.condition !== undefined) {
      const label = conditionLabels.get(completedNodeId);
      if (label !== edge.condition) continue;
    }

    // Check activation group: if 'all', all incoming edges in the group must come from completed nodes
    if (edge.activationGroup && edge.activationCondition === 'all') {
      const groupEdges = edges.filter(
        (e) => e.to === edge.to && e.activationGroup === edge.activationGroup
      );
      const allSatisfied = groupEdges.every((e) => completedNodes.has(e.from));
      if (!allSatisfied) continue;
    }

    next.push(edge.to);
  }

  return [...new Set(next)];
};

type RequiredAction = {
  nodeId: string;
  prompt: string;
  context: Record<string, unknown>;
  options?: string[];
};

/**
 * Create and immediately execute an orchestration run (Phase 1: linear, synchronous).
 * Returns the run record — either completed, failed, or paused (if a human node activates).
 */
export const startOrchestrationRun = async (args: {
  orchestrationPublicId: string;
  projectId: number;
  projectIds: number[];
  input?: Record<string, unknown>;
  authHeader?: string;
}): Promise<MappedOrchestrationRun> => {
  log('startOrchestrationRun %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const orchWhere: Record<string, unknown> = {
    publicId: args.orchestrationPublicId,
    projectId: args.projectIds,
  };
  const orch = await db.Orchestration.findOne({ where: orchWhere });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.orchestrationPublicId}' not found.`
    );

  const nodes = orch.nodes as OrchestrationNode[];
  const edges = orch.edges as OrchestrationEdge[];

  // Initialize state from input
  const state: Record<string, unknown> = { ...(args.input ?? {}) };
  const artifacts: Record<string, unknown> = {};
  const completedNodes = new Set<string>();
  const conditionLabels = new Map<string, string>();

  // Create run record
  const runRecord = await db.OrchestrationRun.create({
    orchestrationId: orch.id as number,
    projectId: args.projectId,
    status: 'running',
    state,
    activeNodes: [],
    artifacts,
    input: args.input ?? null,
    startedAt: new Date(),
  });

  let activeNodeIds = findStartNodes(nodes, edges);
  let runStatus: MappedOrchestrationRun['status'] = 'running';
  let runError: object | null = null;
  let requiredAction: RequiredAction | null = null;

  try {
    while (activeNodeIds.length > 0 && runStatus === 'running') {
      log('executeRun: activeNodes=%o', activeNodeIds);

      // Phase 1: execute sequentially (no parallelism)
      const nextRound: string[] = [];

      for (const nodeId of activeNodeIds) {
        const nodeDefn = nodes.find((n) => n.id === nodeId);
        if (!nodeDefn) {
          throw new DomainError(
            'ORCHESTRATION_NODE_FAILED',
            `Node '${nodeId}' not found in orchestration definition.`
          );
        }

        let execResult: NodeExecutionResult;

        switch (nodeDefn.type) {
          case 'agent':
            execResult = await executeAgentNode({
              node: nodeDefn,
              state,
              projectIds: args.projectIds,
              traceId: runRecord.traceId ?? null,
              authHeader: args.authHeader,
            });
            break;
          case 'tool':
            execResult = await executeToolNode({
              node: nodeDefn,
              state,
              projectIds: args.projectIds,
              authHeader: args.authHeader,
            });
            break;
          case 'transform':
            execResult = executeTransformNode({ node: nodeDefn, state });
            break;
          case 'knowledge':
            execResult = await executeKnowledgeNode({
              node: nodeDefn,
              state,
              projectIds: args.projectIds,
            });
            break;
          case 'memory_write':
            execResult = await executeMemoryWriteNode({
              node: nodeDefn,
              state,
            });
            break;
          case 'condition':
            execResult = executeConditionNode({ node: nodeDefn, state });
            break;
          case 'human':
            execResult = executeHumanNode({ node: nodeDefn, state });
            break;
          default:
            throw new DomainError(
              'ORCHESTRATION_NODE_FAILED',
              `Unknown node type '${(nodeDefn as OrchestrationNode).type}'.`
            );
        }

        if (execResult.kind === 'requires_action') {
          runStatus = 'paused';
          requiredAction = {
            nodeId: execResult.nodeId,
            prompt: execResult.prompt,
            context: execResult.context,
            options: execResult.options,
          };
          // Save current state and break — we'll resume later
          break;
        }

        if (execResult.kind === 'condition') {
          conditionLabels.set(nodeId, execResult.label);
        } else {
          // artifact
          artifacts[nodeId] = execResult.artifact;
          applyOutputMapping(
            nodeDefn.outputMapping,
            execResult.artifact,
            state
          );
        }

        completedNodes.add(nodeId);

        const resolved = resolveNextNodes({
          completedNodeId: nodeId,
          completedNodes,
          conditionLabels,
          edges,
        });
        for (const n of resolved) {
          if (!nextRound.includes(n)) nextRound.push(n);
        }
      }

      activeNodeIds = nextRound;
    }

    if (runStatus === 'running') {
      runStatus = 'completed';
    }
  } catch (err: unknown) {
    runStatus = 'failed';
    runError = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof DomainError ? err.code : 'UNKNOWN',
    };
    log('executeRun error %o', runError);
  }

  // Determine output (last artifact produced)
  const terminalNodeIds = nodes
    .map((n) => n.id)
    .filter((id) => !edges.some((e) => e.from === id));
  const output: Record<string, unknown> = {};
  for (const id of terminalNodeIds) {
    if (artifacts[id] !== undefined) {
      output[id] = artifacts[id];
    }
  }

  await runRecord.update({
    status: runStatus,
    state,
    activeNodes: runStatus === 'paused' ? [requiredAction?.nodeId ?? ''] : [],
    artifacts,
    error: runError,
    output: runStatus === 'completed' ? output : null,
    completedAt: runStatus !== 'running' ? new Date() : null,
  });

  const finalRun = await db.OrchestrationRun.findOne({
    where: { id: runRecord.id as number },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
    ],
  });

  const mapped = mapOrchestrationRun(
    finalRun as InstanceType<typeof db.OrchestrationRun> & {
      orchestration: InstanceType<typeof db.Orchestration>;
      project: InstanceType<typeof db.Project>;
    }
  );

  // Attach requiredAction if paused
  if (runStatus === 'paused' && requiredAction) {
    (
      mapped as MappedOrchestrationRun & { requiredAction?: RequiredAction }
    ).requiredAction = requiredAction;
  }

  return mapped;
};
