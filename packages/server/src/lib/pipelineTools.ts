import createDebug from 'debug';
import jsonLogic from 'json-logic-js';

import { DomainError } from '../errors';
import {
  applyInputMapping,
  applyOutputMapping,
} from './orchestrationNodeExecutors';
import { callTool } from './tools';

const log = createDebug('soat:pipeline');

/**
 * Maximum nesting depth for pipeline tools. A pipeline whose tool nodes
 * (transitively) reference itself would recurse forever; this guard aborts the
 * run once the limit is crossed.
 */
export const MAX_PIPELINE_DEPTH = 10;

// ── Config types (external snake_case contract — stored verbatim) ───────────

type PipelineToolNode = {
  type?: 'tool';
  tool_id?: unknown;
  action?: unknown;
  input_mapping?: unknown;
  output_mapping?: unknown;
};

type PipelineMapNode = {
  type: 'map';
  expression?: unknown;
  output_key?: unknown;
  output_mapping?: unknown;
};

type PipelineNode = PipelineToolNode | PipelineMapNode;

type PipelineConfig = {
  nodes: PipelineNode[];
  output_mapping?: Record<string, unknown>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
};

const nodeType = (node: PipelineNode): 'tool' | 'map' => {
  return (node as { type?: unknown }).type === 'map' ? 'map' : 'tool';
};

// ── Validation (shared by REST/lib and the formation module) ────────────────

const validateNode = (node: unknown, index: number): string | null => {
  if (!isRecord(node)) {
    return `pipeline.nodes[${index}] must be an object.`;
  }
  if ((node.type === 'map' ? 'map' : 'tool') === 'tool') {
    if (typeof node.tool_id !== 'string' || node.tool_id.length === 0) {
      return `pipeline.nodes[${index}] (tool) requires a string \`tool_id\`.`;
    }
    return null;
  }
  if (node.expression === undefined || node.expression === null) {
    return `pipeline.nodes[${index}] (map) requires an \`expression\`.`;
  }
  return null;
};

/**
 * Validates a pipeline tool's `pipeline` configuration. Returns an error
 * message string when invalid, or `null` when valid. Single source of truth for
 * the business rule, reused by both the REST/lib layer and the formation module
 * (see `modules.md` shared-rule pattern).
 */
export const validatePipelineConfig = (args: {
  pipeline: unknown;
}): string | null => {
  const { pipeline } = args;
  if (!isRecord(pipeline)) {
    return 'pipeline must be an object with a `nodes` array.';
  }
  const { nodes } = pipeline as { nodes?: unknown };
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 'pipeline.nodes must be a non-empty array.';
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const nodeError = validateNode(nodes[i], i);
    if (nodeError) return nodeError;
  }
  return null;
};

// ── Execution ───────────────────────────────────────────────────────────────

const runToolNode = async (args: {
  node: PipelineToolNode;
  state: Record<string, unknown>;
  projectIds?: number[];
  authHeader?: string;
  depth: number;
}): Promise<void> => {
  const { node, state, projectIds, authHeader, depth } = args;
  const inputs = applyInputMapping(
    isRecord(node.input_mapping) ? node.input_mapping : undefined,
    state
  );
  const result = await callTool({
    projectIds,
    id: node.tool_id as string,
    action: typeof node.action === 'string' ? node.action : undefined,
    input: inputs,
    authHeader,
    depth: depth + 1,
  });
  const artifact: Record<string, unknown> = isRecord(result)
    ? result
    : { result };
  applyOutputMapping(
    isRecord(node.output_mapping)
      ? (node.output_mapping as Record<string, string>)
      : undefined,
    artifact,
    state
  );
};

const runMapNode = (args: {
  node: PipelineMapNode;
  state: Record<string, unknown>;
}): void => {
  const { node, state } = args;
  const value: unknown = jsonLogic.apply(
    node.expression as Parameters<typeof jsonLogic.apply>[0],
    state
  );
  if (typeof node.output_key === 'string') {
    state[node.output_key] = value;
  }
  if (isRecord(node.output_mapping) && isRecord(value)) {
    applyOutputMapping(
      node.output_mapping as Record<string, string>,
      value,
      state
    );
  }
};

const runNode = async (args: {
  node: PipelineNode;
  index: number;
  toolName: string;
  state: Record<string, unknown>;
  projectIds?: number[];
  authHeader?: string;
  depth: number;
}): Promise<void> => {
  const { node, index, toolName, state, projectIds, authHeader, depth } = args;
  const type = nodeType(node);
  try {
    if (type === 'tool') {
      await runToolNode({
        node: node as PipelineToolNode,
        state,
        projectIds,
        authHeader,
        depth,
      });
    } else {
      runMapNode({ node: node as PipelineMapNode, state });
    }
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === 'PIPELINE_DEPTH_EXCEEDED'
    ) {
      throw error;
    }
    const label =
      type === 'tool'
        ? `tool_id=${String((node as PipelineToolNode).tool_id)}`
        : 'map';
    throw new DomainError(
      'PIPELINE_STEP_FAILED',
      `Pipeline '${toolName}' node ${index} (${type}, ${label}) failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * Executes a `pipeline` tool: walks its nodes in order, threading a shared
 * JSON Logic `state` between them, and returns the value shaped by the
 * top-level `output_mapping` (or the full state when none is given).
 *
 * Runs entirely server-side and synchronously, so a pipeline tool looks like a
 * single deterministic tool call to the model, to `POST /tools/:id/call`, and
 * to orchestration tool nodes.
 */
export const executePipelineTool = async (args: {
  tool: { id?: string; name: string; pipeline: object | null };
  input?: Record<string, unknown>;
  projectIds?: number[];
  authHeader?: string;
  depth?: number;
}): Promise<unknown> => {
  const { tool, input, projectIds, authHeader } = args;
  const depth = args.depth ?? 0;

  log(
    'executePipelineTool: name=%s id=%s depth=%d',
    tool.name,
    tool.id ?? '(unknown)',
    depth
  );

  if (depth > MAX_PIPELINE_DEPTH) {
    throw new DomainError(
      'PIPELINE_DEPTH_EXCEEDED',
      `Pipeline '${tool.name}' exceeded the maximum nesting depth of ${MAX_PIPELINE_DEPTH}.`
    );
  }

  const validationError = validatePipelineConfig({ pipeline: tool.pipeline });
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  const config = tool.pipeline as PipelineConfig;
  const state: Record<string, unknown> = { input: input ?? {} };

  for (let i = 0; i < config.nodes.length; i += 1) {
    await runNode({
      node: config.nodes[i],
      index: i,
      toolName: tool.name,
      state,
      projectIds,
      authHeader,
      depth,
    });
  }

  if (isRecord(config.output_mapping)) {
    return applyInputMapping(config.output_mapping, state);
  }
  return state;
};
