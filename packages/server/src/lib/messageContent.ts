import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import { agentDenied, callerDenied } from './authorizationDenial';
import { getDocument } from './documents';
import {
  buildSrn,
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  type PolicyDocument,
} from './iam';
import { resolveSoatActionScope } from './soatActionScope';
import { soatTools } from './soatTools';
import { buildResourceTagContext } from './tags';
import { callTool, tools } from './tools';

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

const ensureAuthUser = (authUser?: AuthUser): AuthUser => {
  if (!authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  return authUser;
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

const isAgentPolicyAllowed = (args: {
  policy: PolicyDocument | null;
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
}): boolean => {
  if (!args.policy) {
    return true;
  }

  const policies = [args.policy];

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

const assertAgentPolicyAllowed = (args: {
  agentAuthority?: AgentAuthority;
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
}) => {
  if (
    args.agentAuthority &&
    !isAgentPolicyAllowed({
      policy: args.agentAuthority.policy,
      action: args.action,
      resource: args.resource,
      resources: args.resources,
      context: args.context,
    })
  ) {
    throw agentDenied({
      agentId: args.agentAuthority.agentId,
      action: args.action,
      resource: args.resource ?? args.resources?.[0] ?? null,
    });
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
    throw callerDenied({
      authUser,
      action: args.action,
      resource: args.resource ?? args.resources?.[0] ?? null,
    });
  }
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

const findSoatToolDefinition = (action: string) => {
  return soatTools.find((tool) => {
    return tool.name === action;
  });
};

const resolveSoatIamAction = (action: string): string => {
  return findSoatToolDefinition(action)?.iamAction ?? action;
};

const resolveDocumentContent = async (args: {
  content: DocumentMessageContent;
  authUser?: AuthUser;
  agentAuthority?: AgentAuthority;
}): Promise<{ content: string; documentId: string }> => {
  const document = await getDocument({ id: args.content.document_id });

  if (!document || !document.project_id) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Document '${args.content.document_id}' not found.`
    );
  }

  const resources = buildDocumentPermissionResources({
    documentId: args.content.document_id,
    projectPublicId: document.project_id,
    path: document.path,
  });
  const context = buildDocumentPermissionContext({ tags: document.tags });

  await assertCallerAllowed({
    authUser: args.authUser,
    projectPublicId: document.project_id,
    action: 'documents:GetDocument',
    resources,
    context,
  });
  assertAgentPolicyAllowed({
    agentAuthority: args.agentAuthority,
    action: 'documents:GetDocument',
    resources,
    context,
  });

  return {
    content: document.content ?? '',
    documentId: args.content.document_id,
  };
};

/**
 * A builtin action a `tool_output` message names, checked against the same SRN
 * and tags the model's own call to it would be: a boundary confined to one
 * resource must not be wider through the door a caller drives, and the caller
 * names the action, so it must hold it too.
 */
const assertBuiltinActionAllowed = async (args: {
  action: string;
  input?: Record<string, unknown>;
  projectPublicId: string;
  authUser?: AuthUser;
  agentAuthority?: AgentAuthority;
}) => {
  const action = resolveSoatIamAction(args.action);
  const scope = await resolveSoatActionScope({
    resourceRef: findSoatToolDefinition(args.action)?.resource,
    toolArgs: args.input,
  });
  assertAgentPolicyAllowed({
    agentAuthority: args.agentAuthority,
    action,
    resource: scope?.resource ?? '*',
    context: scope?.context,
  });
  await assertCallerAllowed({
    authUser: args.authUser,
    projectPublicId: args.projectPublicId,
    action,
    resource: scope?.resource,
    context: scope?.context,
  });
};

const resolveToolOutputContent = async (args: {
  content: ToolOutputMessageContent;
  projectIds?: number[];
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentAuthority?: AgentAuthority;
  toolContext?: Record<string, string>;
}): Promise<{ content: string }> => {
  assertToolAllowedForAgent({
    allowedToolIds: args.allowedToolIds,
    agentId: args.agentAuthority?.agentId ?? null,
    toolId: args.content.tool_id,
  });

  const toolRow = await tools.getByPublicId({
    projectIds: args.projectIds,
    id: args.content.tool_id,
  });
  const tool = { project_id: toolRow.project.publicId, type: toolRow.type };

  await assertCallerAllowed({
    authUser: args.authUser,
    projectPublicId: tool.project_id,
    action: 'tools:CallTool',
  });

  if (tool.type === 'builtin' && args.content.action) {
    await assertBuiltinActionAllowed({
      action: args.content.action,
      input: args.content.input,
      projectPublicId: tool.project_id,
      authUser: args.authUser,
      agentAuthority: args.agentAuthority,
    });
  }

  const toolResult = await callTool({
    guardrails: 'apply',
    projectId: toolRow.projectId,
    reach: 'project',
    id: args.content.tool_id,
    action: args.content.action,
    input: args.content.input,
    authHeader: args.authHeader,
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

  return { content: stringifyToolOutput(resolvedContent) };
};

export const resolveMessageContent = async (args: {
  content: ResolvableMessageContent;
  projectIds?: number[];
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentAuthority?: AgentAuthority;
  toolContext?: Record<string, string>;
}): Promise<{ content: string; documentId?: string }> => {
  if (typeof args.content === 'string') {
    return { content: args.content };
  }

  if (isDocumentMessageContent(args.content)) {
    return resolveDocumentContent({
      content: args.content,
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
    authHeader: args.authHeader,
    authUser: args.authUser,
    allowedToolIds: args.allowedToolIds,
    agentAuthority: args.agentAuthority,
    toolContext: args.toolContext,
  });
};
