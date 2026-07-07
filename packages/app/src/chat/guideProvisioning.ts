import { apiFetch } from '@/api/client';
import type { ModuleInfo } from '@/engine/types';

import {
  buildGuideInstructions,
  GUIDE_AGENT_NAME,
  RENDER_PAGE_TOOL_DESCRIPTION,
  RENDER_PAGE_TOOL_NAME,
  renderPageParameters,
} from './guideConfig';
import type { AiProvider } from './types';

type NamedRecord = { id: string; name?: string; type?: string };
type AgentRecord = {
  id: string;
  name?: string;
  ai_provider_id?: string;
  tool_ids?: string[];
};

export type ProvisionResult =
  { ok: true; agentId: string } | { ok: false; error: string };

const GUIDE_UNAVAILABLE =
  'The guide is unavailable for you. Ask an admin to grant agent and tool permissions in this project.';

export const listAiProviders = async (args: {
  token: string;
  projectId: string;
}): Promise<AiProvider[]> => {
  const result = await apiFetch<unknown>({
    url: `/api/v1/ai-providers?project_id=${encodeURIComponent(args.projectId)}`,
    token: args.token,
  });
  if (!result.ok || !Array.isArray(result.data)) return [];
  return result.data.filter((item): item is AiProvider => {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as AiProvider).id === 'string'
    );
  });
};

const findByName = <T extends { name?: string }>(
  list: unknown,
  name: string
): T | null => {
  if (!Array.isArray(list)) return null;
  return (
    (list.find((item) => {
      return (
        typeof item === 'object' && item !== null && (item as T).name === name
      );
    }) as T | undefined) ?? null
  );
};

// Find or create the render_page client tool. Returns the tool's public id.
const ensureRenderPageTool = async (args: {
  token: string;
  projectId: string;
}): Promise<string | null> => {
  const existing = await apiFetch<unknown>({
    url: `/api/v1/tools?project_id=${encodeURIComponent(args.projectId)}`,
    token: args.token,
  });
  if (!existing.ok) return null;
  const found = findByName<NamedRecord>(existing.data, RENDER_PAGE_TOOL_NAME);
  if (found) return found.id;

  const created = await apiFetch<NamedRecord>({
    url: '/api/v1/tools',
    method: 'POST',
    token: args.token,
    body: {
      project_id: args.projectId,
      name: RENDER_PAGE_TOOL_NAME,
      type: 'client',
      description: RENDER_PAGE_TOOL_DESCRIPTION,
      parameters: renderPageParameters,
    },
  });
  return created.ok ? created.data.id : null;
};

// Find or create the soat-app-guide agent bound to the chosen provider with the
// render_page tool attached. Idempotent: re-binds the provider if it changed.
export const provisionGuide = async (args: {
  token: string;
  projectId: string;
  providerId: string;
  modules: ModuleInfo[];
}): Promise<ProvisionResult> => {
  const toolId = await ensureRenderPageTool({
    token: args.token,
    projectId: args.projectId,
  });
  if (!toolId) return { ok: false, error: GUIDE_UNAVAILABLE };

  const instructions = buildGuideInstructions({
    modules: args.modules,
    projectId: args.projectId,
  });

  const list = await apiFetch<unknown>({
    url: `/api/v1/agents?project_id=${encodeURIComponent(args.projectId)}`,
    token: args.token,
  });
  if (!list.ok) return { ok: false, error: GUIDE_UNAVAILABLE };

  const existing = findByName<AgentRecord>(list.data, GUIDE_AGENT_NAME);

  if (!existing) {
    const created = await apiFetch<AgentRecord>({
      url: '/api/v1/agents',
      method: 'POST',
      token: args.token,
      body: {
        project_id: args.projectId,
        ai_provider_id: args.providerId,
        name: GUIDE_AGENT_NAME,
        instructions,
        tool_ids: [toolId],
      },
    });
    return created.ok
      ? { ok: true, agentId: created.data.id }
      : { ok: false, error: GUIDE_UNAVAILABLE };
  }

  // Re-bind the provider / tool when the selection drifted from the stored agent.
  const toolIds = existing.tool_ids ?? [];
  const needsUpdate =
    existing.ai_provider_id !== args.providerId || !toolIds.includes(toolId);
  if (needsUpdate) {
    await apiFetch<AgentRecord>({
      url: `/api/v1/agents/${encodeURIComponent(existing.id)}`,
      method: 'PUT',
      token: args.token,
      body: {
        ai_provider_id: args.providerId,
        instructions,
        tool_ids: toolIds.includes(toolId) ? toolIds : [...toolIds, toolId],
      },
    });
  }

  return { ok: true, agentId: existing.id };
};
