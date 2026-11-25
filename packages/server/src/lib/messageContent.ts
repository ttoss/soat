import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import { agentDenied } from './authorizationDenial';
import { getDocument } from './documents';
import {
  type ProvenanceMetric,
  resultProvenance,
} from './generationProvenance';
import { buildSrn } from './iam';
import { buildResourceTagContext } from './tags';
import { type ToolOutputPart, toolOutputParts } from './toolResultFiles';
import { callTool, tools } from './tools';
import { assertAllowedUnder, callerNamedAuthority } from './turnAuthority';
import type { WorkAuthority } from './workAuthority';

export type ToolOutputMessageContent = {
  type: 'tool_output';
  tool_id: string;
  action?: string;
  input?: Record<string, unknown>;
  output_path?: string;
};

export type DocumentMessageContent = {
  type: 'document';
  document_id: string;
};

export type ResolvableMessageContent =
  string | ToolOutputMessageContent | DocumentMessageContent;

export const isDocumentMessageContent = (
  value: unknown
): value is DocumentMessageContent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'document' && typeof record.document_id === 'string';
};

export const isToolOutputMessageContent = (
  value: unknown
): value is ToolOutputMessageContent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'tool_output' && typeof record.tool_id === 'string';
};

const resolvePathValue = (args: {
  value: unknown;
  outputPath: string;
}): unknown => {
  const segments = args.outputPath.split('.').filter(Boolean);
  let current: unknown = args.value;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!current || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
};

const stringifyToolOutput = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (value === null) return 'null';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const buildDocumentPermissionContext = (args: {
  tags?: Record<string, string> | null;
}): Record<string, string> => {
  return buildResourceTagContext({ resourceType: 'document', tags: args.tags });
};

const buildDocumentPermissionResources = (args: {
  documentId: string;
  projectPublicId: string;
  path?: string;
}): string[] => {
  const resources = [
    buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: 'document',
      resourceId: args.documentId,
    }),
  ];

  if (args.path) {
    resources.push(
      buildSrn({
        projectPublicId: args.projectPublicId,
        resourceType: 'document',
        resourceId: args.path,
      })
    );
  }

  return resources;
};

const assertToolAllowedForAgent = (args: {
  allowedToolIds?: string[];
  agentId: string | null;
  toolId: string;
}) => {
  if (!args.allowedToolIds?.includes(args.toolId)) {
    throw agentDenied({
      agentId: args.agentId,
      action: 'tools:CallTool',
      resource: null,
    });
  }
};

/**
 * What the caller names in a turn's messages is read as the caller
 * (`callerNamedAuthority`), whatever the agent runs as. The lookup is held to
 * the turn's project before any check, so a document elsewhere answers as a
 * made-up id does instead of a refusal naming its project.
 */
const resolveDocumentContent = async (args: {
  content: DocumentMessageContent;
  turnProjectId: number;
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  agentAuthority?: AgentAuthority;
}): Promise<{
  content: string;
  documentId: string;
  provenance: ProvenanceMetric;
}> => {
  const document = await getDocument({
    id: args.content.document_id,
    projectIds: [args.turnProjectId],
  });

  if (!document || !document.project_id) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Document '${args.content.document_id}' not found.`
    );
  }

  await assertAllowedUnder({
    authority: callerNamedAuthority(args),
    caller: args.authUser,
    checks: [
      {
        projectPublicId: document.project_id,
        action: 'documents:GetDocument',
        resources: buildDocumentPermissionResources({
          documentId: args.content.document_id,
          projectPublicId: document.project_id,
          path: document.path,
        }),
        context: buildDocumentPermissionContext({ tags: document.tags }),
      },
    ],
  });

  return {
    content: document.content ?? '',
    documentId: args.content.document_id,
    provenance: 'knowledge_results',
  };
};

const resolveToolOutputContent = async (args: {
  content: ToolOutputMessageContent;
  projectIds?: number[];
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentAuthority?: AgentAuthority;
  toolContext?: Record<string, string>;
}): Promise<{
  content: string;
  parts: ToolOutputPart[] | null;
  provenance: ProvenanceMetric | null;
}> => {
  assertToolAllowedForAgent({
    allowedToolIds: args.allowedToolIds,
    agentId: args.agentAuthority?.agentId ?? null,
    toolId: args.content.tool_id,
  });

  const toolRow = await tools.getByPublicId({
    projectIds: args.projectIds,
    id: args.content.tool_id,
  });

  // Under the caller's authority, `callTool` checks `tools:CallTool` on the
  // tool and each builtin action it reaches (named, preset or a pipeline
  // step's) at the action's route.
  const toolResult = await callTool({
    guardrails: 'apply',
    projectId: toolRow.projectId,
    reach: 'project',
    id: args.content.tool_id,
    action: args.content.action,
    input: args.content.input,
    authority: callerNamedAuthority(args),
    caller: args.authUser,
    // The generation calling a tool on its own behalf, so it carries the same
    // bag the model's own tool calls resolve from.
    toolContext: args.toolContext,
    // Resolved before the generation row exists, so there is no turn to name.
    attribution: {},
  });

  const resolvedContent = args.content.output_path
    ? resolvePathValue({
        value: toolResult,
        outputPath: args.content.output_path,
      })
    : toolResult;

  if (resolvedContent === undefined) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `outputPath '${args.content.output_path}' could not be resolved from tool output.`
    );
  }

  return {
    content: stringifyToolOutput(resolvedContent),
    parts: toolOutputParts(resolvedContent),
    provenance: resultProvenance({
      toolType: toolRow.type,
      action: args.content.action,
      trustedOutput: toolRow.trustedOutput,
    }),
  };
};

export const resolveMessageContent = async (args: {
  content: ResolvableMessageContent;
  /** The project the turn runs in, where a named document resolves. */
  turnProjectId: number;
  projectIds?: number[];
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentAuthority?: AgentAuthority;
  toolContext?: Record<string, string>;
}): Promise<{
  content: string;
  documentId?: string;
  /** A `tool_output` block's result as parts, when its tool returns files. */
  parts?: ToolOutputPart[] | null;
  /** The counter the content feeds as it enters a generation's context. */
  provenance?: ProvenanceMetric | null;
}> => {
  if (typeof args.content === 'string') {
    return { content: args.content };
  }

  if (isDocumentMessageContent(args.content)) {
    return resolveDocumentContent({
      content: args.content,
      turnProjectId: args.turnProjectId,
      authority: args.authority,
      authUser: args.authUser,
      agentAuthority: args.agentAuthority,
    });
  }

  if (!isToolOutputMessageContent(args.content)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'message content must be a string or a valid tool_output/document object.'
    );
  }

  return resolveToolOutputContent({
    content: args.content,
    projectIds: args.projectIds,
    authority: args.authority,
    authUser: args.authUser,
    allowedToolIds: args.allowedToolIds,
    agentAuthority: args.agentAuthority,
    toolContext: args.toolContext,
  });
};
