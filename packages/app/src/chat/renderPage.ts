import { viewToPath } from '@/engine/routeUtils';
import type {
  ModuleInfo,
  ModuleOp,
  OpenApiSpec,
  ViewDescriptor,
  ViewMode,
} from '@/engine/types';

const VIEW_MODES: ViewMode[] = ['list', 'detail', 'create', 'edit', 'action'];

const moduleOps = (m: ModuleInfo): ModuleOp[] => {
  return [
    m.listOp,
    m.getOp,
    m.createOp,
    m.updateOp,
    m.deleteOp,
    ...(m.actions ?? []),
  ].filter((op): op is ModuleOp => {
    return op !== undefined;
  });
};

// The module owning an operationId. Used to label the descriptor and to decide
// whether the active project must be injected; navigation re-derives the tag
// from the resulting URL.
const moduleForOperation = (
  operationId: string,
  modules: ModuleInfo[]
): ModuleInfo | null => {
  for (const m of modules) {
    if (
      moduleOps(m).some((op) => {
        return op.operation.operationId === operationId;
      })
    ) {
      return m;
    }
  }
  return null;
};

const coerceStringRecord = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== null && val !== undefined) out[key] = String(val);
  }
  return out;
};

// Translate a render_page tool call into a validated ViewDescriptor. Returns
// null when the operationId or mode is missing/invalid so the caller can report
// a tool error instead of crashing the engine.
export const toViewDescriptor = (args: {
  toolArgs: Record<string, unknown>;
  modules: ModuleInfo[];
  activeProjectId: string | null;
}): ViewDescriptor | null => {
  const { operationId, mode } = args.toolArgs;
  if (typeof operationId !== 'string' || !operationId) return null;
  if (typeof mode !== 'string' || !VIEW_MODES.includes(mode as ViewMode)) {
    return null;
  }

  const module = moduleForOperation(operationId, args.modules);
  if (module === null) return null;

  // Inject the active project for project-scoped views so the model does not
  // have to repeat the project id on every call.
  const pathParams = coerceStringRecord(args.toolArgs.pathParams);
  if (
    module.isProjectScoped &&
    args.activeProjectId &&
    !pathParams.project_id
  ) {
    pathParams.project_id = args.activeProjectId;
  }

  return { tag: module.tag, operationId, pathParams, mode: mode as ViewMode };
};

export type RenderPageResult = {
  output: Record<string, unknown>;
  view?: ViewDescriptor;
};

// Execute a render_page tool call: validate the descriptor against the spec,
// mount the view, and return a compact summary to feed back to the model.
export const executeRenderPage = (args: {
  toolArgs: Record<string, unknown>;
  spec: OpenApiSpec;
  modules: ModuleInfo[];
  activeProjectId: string | null;
  navigate: (descriptor: ViewDescriptor) => void;
}): RenderPageResult => {
  const descriptor = toViewDescriptor({
    toolArgs: args.toolArgs,
    modules: args.modules,
    activeProjectId: args.activeProjectId,
  });

  if (!descriptor || viewToPath(descriptor, args.spec) === null) {
    return {
      output: {
        ok: false,
        error: `Cannot render: unknown operationId '${String(
          args.toolArgs.operationId
        )}' or invalid mode.`,
      },
    };
  }

  args.navigate(descriptor);
  return {
    output: {
      ok: true,
      operationId: descriptor.operationId,
      mode: descriptor.mode,
    },
    view: descriptor,
  };
};
