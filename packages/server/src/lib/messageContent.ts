import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import { getDocument } from './documents';
import {
  buildSrn,
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  type PolicyDocument,
  validatePolicyDocument,
} from './iam';
import { soatTools } from './soatTools';
import { callTool, getTool } from './tools';

export type ToolOutputMessageContent = {
  type: 'tool_output';
  toolId: string;
  action?: string;
  input?: Record<string, unknown>;
  outputPath?: string;
};

export type DocumentMessageContent = {
  type: 'document';
  documentId: string;
};

export type ResolvableMessageContent =
  string | ToolOutputMessageContent | DocumentMessageContent;

export const isDocumentMessageContent = (
  value: unknown
): value is DocumentMessageContent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'document' && typeof record.documentId === 'string';
};

export const isToolOutputMessageContent = (
  value: unknown
): value is ToolOutputMessageContent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'tool_output' && typeof record.toolId === 'string';
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

const ensureAuthUser = (authUser?: AuthUser): AuthUser => {
  if (!authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  return authUser;
};

const buildDocumentPermissionContext = (args: {
  tags?: Record<string, unknown>;
}): Record<string, string> => {
  const context: Record<string, string> = { 'soat:ResourceType': 'document' };

  if (!args.tags) {
    return context;
  }

  for (const [key, value] of Object.entries(args.tags)) {
    context[`soat:ResourceTag/${key}`] = String(value);
  }

  return context;
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

const isBoundaryAllowed = (args: {
  boundaryPolicy?: unknown;
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
}): boolean => {
  if (!args.boundaryPolicy) {
    return true;
  }

  const validation = validatePolicyDocument(args.boundaryPolicy);
  if (!validation.valid) {
    return false;
  }

  const policies = [args.boundaryPolicy as PolicyDocument];

  if (args.resources && args.resources.length > 0) {
    return evaluatePoliciesMultiResource({
      policies,
      action: args.action,
      resources: args.resources,
      context: args.context,
    });
  }

  return evaluatePolicies({
    policies,
    action: args.action,
    resource: args.resource,
    context: args.context,
  });
};

const assertBoundaryAllowed = (args: {
  boundaryPolicy?: unknown;
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
}) => {
  if (
    !isBoundaryAllowed({
      boundaryPolicy: args.boundaryPolicy,
      action: args.action,
      resource: args.resource,
      resources: args.resources,
      context: args.context,
    })
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

const assertCallerAllowed = async (args: {
  authUser?: AuthUser;
  projectPublicId: string;
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
}) => {
  const authUser = ensureAuthUser(args.authUser);
  const allowed = await authUser.isAllowed({
    projectPublicId: args.projectPublicId,
    action: args.action,
    resource: args.resource,
    resources: args.resources,
    context: args.context,
  });

  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

const assertToolAllowedForAgent = (args: {
  allowedToolIds?: string[];
  toolId: string;
}) => {
  if (!args.allowedToolIds?.includes(args.toolId)) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

const resolveSoatIamAction = (action: string): string => {
  const definition = soatTools.find((tool) => {
    return tool.name === action;
  });

  return definition?.iamAction ?? action;
};

const resolveDocumentContent = async (args: {
  content: DocumentMessageContent;
  authUser?: AuthUser;
  agentBoundaryPolicy?: unknown;
}): Promise<{ content: string; documentId: string }> => {
  const document = await getDocument({ id: args.content.documentId });

  if (!document || !document.projectId) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Document '${args.content.documentId}' not found.`
    );
  }

  const resources = buildDocumentPermissionResources({
    documentId: args.content.documentId,
    projectPublicId: document.projectId,
    path: document.path,
  });
  const context = buildDocumentPermissionContext({ tags: document.tags });

  await assertCallerAllowed({
    authUser: args.authUser,
    projectPublicId: document.projectId,
    action: 'documents:GetDocument',
    resources,
    context,
  });
  assertBoundaryAllowed({
    boundaryPolicy: args.agentBoundaryPolicy,
    action: 'documents:GetDocument',
    resources,
    context,
  });

  return {
    content: document.content ?? '',
    documentId: args.content.documentId,
  };
};

const resolveToolOutputContent = async (args: {
  content: ToolOutputMessageContent;
  projectIds?: number[];
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentBoundaryPolicy?: unknown;
}): Promise<{ content: string }> => {
  assertToolAllowedForAgent({
    allowedToolIds: args.allowedToolIds,
    toolId: args.content.toolId,
  });

  const tool = await getTool({
    projectIds: args.projectIds,
    id: args.content.toolId,
  });

  await assertCallerAllowed({
    authUser: args.authUser,
    projectPublicId: tool.projectId,
    action: 'tools:CallTool',
  });

  if (tool.type === 'soat' && args.content.action) {
    assertBoundaryAllowed({
      boundaryPolicy: args.agentBoundaryPolicy,
      action: resolveSoatIamAction(args.content.action),
      resource: '*',
    });
  }

  const toolResult = await callTool({
    projectIds: args.projectIds,
    id: args.content.toolId,
    action: args.content.action,
    input: args.content.input,
    authHeader: args.authHeader,
  });

  const resolvedContent = args.content.outputPath
    ? resolvePathValue({
        value: toolResult,
        outputPath: args.content.outputPath,
      })
    : toolResult;

  if (resolvedContent === undefined) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `outputPath '${args.content.outputPath}' could not be resolved from tool output.`
    );
  }

  return { content: stringifyToolOutput(resolvedContent) };
};

export const resolveMessageContent = async (args: {
  content: ResolvableMessageContent;
  projectIds?: number[];
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentBoundaryPolicy?: unknown;
}): Promise<{ content: string; documentId?: string }> => {
  if (typeof args.content === 'string') {
    return { content: args.content };
  }

  if (isDocumentMessageContent(args.content)) {
    return resolveDocumentContent({
      content: args.content,
      authUser: args.authUser,
      agentBoundaryPolicy: args.agentBoundaryPolicy,
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
    authHeader: args.authHeader,
    authUser: args.authUser,
    allowedToolIds: args.allowedToolIds,
    agentBoundaryPolicy: args.agentBoundaryPolicy,
  });
};
