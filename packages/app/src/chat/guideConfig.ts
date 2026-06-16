import type { ModuleInfo, ModuleOp } from '@/engine/types';

// Identity of the find-or-created guide resources, per project.
export const GUIDE_AGENT_NAME = 'soat-app-guide';
export const RENDER_PAGE_TOOL_NAME = 'render_page';

// JSON Schema for the render_page client tool. Tool schemas are camelCase by
// convention (they are not part of the snake_case REST contract), so the model
// returns args keyed by operationId/pathParams/mode.
export const renderPageParameters = {
  type: 'object',
  required: ['operationId', 'mode'],
  properties: {
    operationId: {
      type: 'string',
      description:
        'The OpenAPI operationId of the view to mount, e.g. "listAgents", "getAgent", "createAgent".',
    },
    mode: {
      type: 'string',
      enum: ['list', 'detail', 'create', 'edit', 'action'],
      description:
        'list (collection), detail (single item), create/edit (forms), action (item-scoped POST).',
    },
    pathParams: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description:
        'Path parameters required by the operation, e.g. { "agent_id": "agt_123" }. project_id is injected automatically for project-scoped views.',
    },
  },
} as const;

export const RENDER_PAGE_TOOL_DESCRIPTION =
  'Mount a view in the SOAT App UI for the user. Use it whenever the user asks to see, open, create, or edit a resource.';

// A compact per-module index of the operations the guide can render, so the
// model knows what it can mount without receiving the full OpenAPI document.
const describeOp = (mode: string, op: ModuleOp | undefined): string | null => {
  if (!op) return null;
  return `${op.operation.operationId} (${mode})`;
};

const moduleIndexLine = (m: ModuleInfo): string => {
  const ops = [
    describeOp('list', m.listOp),
    describeOp('detail', m.getOp),
    describeOp('create', m.createOp),
    describeOp('edit', m.updateOp),
    ...(m.actions ?? []).map((op) => {
      return describeOp('action', op);
    }),
  ].filter((entry): entry is string => {
    return entry !== null;
  });
  return `- ${m.label}${m.isProjectScoped ? ' (project-scoped)' : ''}: ${ops.join(', ')}`;
};

export const buildModuleIndex = (modules: ModuleInfo[]): string => {
  return modules
    .filter((m) => {
      return m.listOp || m.getOp || m.createOp || (m.actions?.length ?? 0) > 0;
    })
    .map(moduleIndexLine)
    .join('\n');
};

export const buildGuideInstructions = (args: {
  modules: ModuleInfo[];
  projectId: string;
}): string => {
  return [
    'You are the SOAT App guide. You help the user navigate the SOAT web app by',
    `mounting views with the "${RENDER_PAGE_TOOL_NAME}" tool. The user is working`,
    `in project "${args.projectId}".`,
    '',
    'When the user asks to see, open, create, or edit a resource, call',
    `"${RENDER_PAGE_TOOL_NAME}" with the operationId, the mode, and any required`,
    'path parameters. Do not invent operationIds — use only those listed below.',
    'After mounting a view, briefly confirm what you showed. For plain questions,',
    'just answer without mounting anything.',
    '',
    'Available views:',
    buildModuleIndex(args.modules),
  ].join('\n');
};
