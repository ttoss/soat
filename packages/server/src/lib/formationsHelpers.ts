import { db } from 'src/db';

import type {
  FormationTemplate,
  ParamExpression,
  RefExpression,
  SubExpression,
} from './formationsTypes';

// ── Ref Utilities ─────────────────────────────────────────────────────────

export const isRef = (value: unknown): value is RefExpression => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'ref' in value &&
    typeof (value as Record<string, unknown>).ref === 'string'
  );
};

export const collectRefs = (value: unknown): string[] => {
  if (isRef(value)) return [value.ref];
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(collectRefs);
  }
  return [];
};

export const resolveRefs = (
  value: unknown,
  resolvedIds: Map<string, string>
): unknown => {
  if (isRef(value)) {
    const physicalId = resolvedIds.get(value.ref);
    if (physicalId === undefined) {
      throw new Error(`Unresolved ref: ${value.ref}`);
    }
    return physicalId;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      return resolveRefs(item, resolvedIds);
    });
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveRefs(v, resolvedIds);
    }
    return result;
  }
  return value;
};

// ── Param Utilities ───────────────────────────────────────────────────────

export const isParam = (value: unknown): value is ParamExpression => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'param' in value &&
    typeof (value as Record<string, unknown>).param === 'string'
  );
};

export const isSub = (value: unknown): value is SubExpression => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'sub' in value &&
    typeof (value as Record<string, unknown>).sub === 'string'
  );
};

const SUB_PARAM_RE = /\$\{([^}]+)\}/g;

export const collectParamRefs = (value: unknown): string[] => {
  if (isParam(value)) return [value.param];
  if (isSub(value)) {
    const matches = [...value.sub.matchAll(SUB_PARAM_RE)];
    return matches.map((m) => {
      return m[1];
    });
  }
  if (Array.isArray(value)) return value.flatMap(collectParamRefs);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(
      collectParamRefs
    );
  }
  return [];
};

export const resolveParamExpressions = (
  value: unknown,
  resolvedParams: Map<string, string>
): unknown => {
  if (isParam(value)) {
    const resolved = resolvedParams.get(value.param);
    if (resolved === undefined) {
      throw new Error(`Unresolved parameter: ${value.param}`);
    }
    return resolved;
  }
  if (isSub(value)) {
    return value.sub.replace(SUB_PARAM_RE, (_, name: string) => {
      const resolved = resolvedParams.get(name);
      if (resolved === undefined) {
        throw new Error(`Unresolved parameter in sub expression: ${name}`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      return resolveParamExpressions(item, resolvedParams);
    });
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveParamExpressions(v, resolvedParams);
    }
    return result;
  }
  return value;
};

export const buildResolvedParamsMap = (
  template: FormationTemplate,
  provided?: Record<string, string>
): Map<string, string> => {
  const resolved = new Map<string, string>();
  if (!template.parameters) return resolved;

  for (const [name, decl] of Object.entries(template.parameters)) {
    const providedValue = provided?.[name];
    if (providedValue !== undefined) {
      resolved.set(name, providedValue);
    } else if (decl.default !== undefined) {
      resolved.set(name, decl.default);
    }
  }

  return resolved;
};

export const getMissingParams = (
  template: FormationTemplate,
  provided?: Record<string, string>
): string[] => {
  const usedParams = new Set([
    ...collectParamRefs(template.resources),
    ...collectParamRefs(template.outputs ?? {}),
  ]);

  const missing: string[] = [];
  for (const name of usedParams) {
    const decl = template.parameters?.[name];
    const providedValue = provided?.[name];
    const hasValue =
      (providedValue !== undefined && providedValue !== '') ||
      decl?.default !== undefined;
    if (!hasValue) {
      missing.push(name);
    }
  }
  return missing;
};

// ── Dependency Graph ──────────────────────────────────────────────────────

export const buildDependencyGraph = (
  template: FormationTemplate
): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>();
  for (const [logicalId, decl] of Object.entries(template.resources)) {
    const deps = new Set<string>();
    for (const ref of collectRefs(decl.properties)) {
      if (ref !== logicalId) deps.add(ref);
    }
    for (const dep of decl.depends_on ?? []) {
      if (dep !== logicalId) deps.add(dep);
    }
    graph.set(logicalId, deps);
  }
  return graph;
};

export const topologicalSort = (
  graph: Map<string, Set<string>>
): string[] | null => {
  const depCount = new Map<string, number>();
  for (const [node, deps] of graph.entries()) {
    depCount.set(node, deps.size);
  }
  const queue: string[] = [];
  for (const [node, count] of depCount.entries()) {
    if (count === 0) queue.push(node);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const [other, deps] of graph.entries()) {
      if (deps.has(node)) {
        const newCount = (depCount.get(other) ?? 1) - 1;
        depCount.set(other, newCount);
        if (newCount === 0) queue.push(other);
      }
    }
  }
  if (sorted.length !== graph.size) return null;
  return sorted;
};

// ── Internal ID Lookups ───────────────────────────────────────────────────

export const lookupSecretInternalId = async (
  publicId: string
): Promise<number> => {
  const secret = await db.Secret.findOne({ where: { publicId } });
  if (!secret) throw new Error(`Secret not found: ${publicId}`);
  return (secret as unknown as { id: number }).id;
};

export const lookupMemoryInternalId = async (
  publicId: string
): Promise<number> => {
  const memory = await db.Memory.findOne({ where: { publicId } });
  if (!memory) throw new Error(`Memory not found: ${publicId}`);
  return (memory as unknown as { id: number }).id;
};

export const lookupActorInternalId = async (
  publicId: string
): Promise<number> => {
  const actor = await db.Actor.findOne({ where: { publicId } });
  if (!actor) throw new Error(`Actor not found: ${publicId}`);
  return (actor as unknown as { id: number }).id;
};

export const lookupAgentInternalId = async (
  publicId: string
): Promise<number> => {
  const agent = await db.Agent.findOne({ where: { publicId } });
  if (!agent) throw new Error(`Agent not found: ${publicId}`);
  return (agent as unknown as { id: number }).id;
};

export const lookupChatInternalId = async (
  publicId: string
): Promise<number> => {
  const chat = await db.Chat.findOne({ where: { publicId } });
  if (!chat) throw new Error(`Chat not found: ${publicId}`);
  return (chat as unknown as { id: number }).id;
};

export const lookupProjectOwnerUserId = async (
  projectId: number
): Promise<number> => {
  // Projects do not have a direct owner. Look for an existing API key for
  // this project to reuse its userId, or fall back to the first user in
  // the system (the bootstrap admin).
  const existingKey = await db.ApiKey.findOne({ where: { projectId } });
  if (existingKey) {
    return (existingKey as unknown as { userId: number }).userId;
  }
  const adminUser = await db.User.findOne({ order: [['id', 'ASC']] });
  if (!adminUser) throw new Error('No users found in the system.');
  return (adminUser as unknown as { id: number }).id;
};

export const lookupPolicyInternalIds = async (
  publicIds: string[]
): Promise<number[]> => {
  if (publicIds.length === 0) return [];
  const policies = await db.Policy.findAll({ where: { publicId: publicIds } });
  if (policies.length !== publicIds.length) {
    const foundIds = new Set(
      policies.map((p) => {
        return (p as unknown as { publicId: string }).publicId;
      })
    );
    const missing = publicIds.find((id) => {
      return !foundIds.has(id);
    });
    throw new Error(`Policy not found: ${missing}`);
  }
  return policies.map((p) => {
    return (p as unknown as { id: number }).id;
  });
};
