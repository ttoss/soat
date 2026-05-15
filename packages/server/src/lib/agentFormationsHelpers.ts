import { db } from 'src/db';

import type { FormationTemplate, RefExpression } from './agentFormationsTypes';

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
