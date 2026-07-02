import { db } from 'src/db';

import type {
  FormationTemplate,
  ParameterDeclaration,
  ParamExpression,
  RefAttrExpression,
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
  if (isSub(value)) {
    // A sub surviving param resolution only carries resource logical ids and
    // `body.*` tokens. Substitute physical ids; leave `body.*` (resolved at
    // tool-call time) intact.
    return value.sub.replace(SUB_PARAM_RE, (original, name: string) => {
      return resolvedIds.get(name) ?? original;
    });
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

export const isRefAttr = (value: unknown): value is RefAttrExpression => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'ref_attr' in value &&
    typeof (value as Record<string, unknown>).ref_attr === 'string'
  );
};

export const collectRefAttrs = (value: unknown): string[] => {
  if (isRefAttr(value)) return [value.ref_attr];
  if (Array.isArray(value)) return value.flatMap(collectRefAttrs);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(
      collectRefAttrs
    );
  }
  return [];
};

/**
 * Parses a ref_attr string of the form `"<LogicalId>.<attributeName>"`.
 * Returns `null` if the separator is missing or either part is empty.
 */
export const parseRefAttr = (
  refAttr: string
): { logicalId: string; attrName: string } | null => {
  const dotIndex = refAttr.indexOf('.');
  if (dotIndex <= 0) return null;
  const logicalId = refAttr.slice(0, dotIndex);
  const attrName = refAttr.slice(dotIndex + 1);
  if (!attrName) return null;
  return { logicalId, attrName };
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

/**
 * Collects every `${Name}` token found inside sub expressions, excluding
 * `body.*` tokens (which are resolved at tool-call time). A token may name a
 * template parameter or a resource logical id — callers disambiguate.
 */
export const collectSubTokens = (value: unknown): string[] => {
  if (isSub(value)) {
    return [...value.sub.matchAll(SUB_PARAM_RE)]
      .map((m) => {
        return m[1];
      })
      .filter((name) => {
        return !name.startsWith('body.');
      });
  }
  if (Array.isArray(value)) return value.flatMap(collectSubTokens);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(
      collectSubTokens
    );
  }
  return [];
};

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
  resolvedParams: Map<string, string>,
  resourceLogicalIds?: Set<string>
): unknown => {
  if (isParam(value)) {
    // An unresolved param resolves to `undefined`, which drops the field from
    // the resolved properties. Required params that are neither supplied nor
    // kept are rejected upstream (`getMissingParams`), so the only way a param
    // reaches here unresolved is an explicit "use previous value" request — the
    // field is then intentionally omitted so the existing value is preserved.
    return resolvedParams.get(value.param);
  }
  if (isSub(value)) {
    let hasUnresolved = false;
    let hasResourceRef = false;
    const replaced = value.sub.replace(
      SUB_PARAM_RE,
      (original, name: string) => {
        // body.xxx refs are resolved at tool-call time, not formation-apply time
        if (name.startsWith('body.')) return original;
        // Resource logical ids are resolved to physical ids later, by
        // resolveRefs at apply time — keep the token and the sub wrapper.
        if (resourceLogicalIds?.has(name)) {
          hasResourceRef = true;
          return original;
        }
        const resolved = resolvedParams.get(name);
        if (resolved === undefined) {
          hasUnresolved = true;
          return original;
        }
        return resolved;
      }
    );
    // If any (non-body) param in the interpolation was kept/omitted, drop the
    // whole value so the previous value is preserved rather than writing a
    // partially-substituted string.
    if (hasUnresolved) return undefined;
    return hasResourceRef ? { sub: replaced } : replaced;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      return resolveParamExpressions(item, resolvedParams, resourceLogicalIds);
    });
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveParamExpressions(
        v,
        resolvedParams,
        resourceLogicalIds
      );
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
    // A parameter declared `use_previous_value` and not supplied is left
    // unresolved on purpose: its `{ param: ... }` expression resolves to
    // `undefined`, the field is dropped, and the existing value is preserved.
  }

  return resolved;
};

// Build the template with param expressions resolved. Resolution runs whenever
// the template declares parameters (not only when values resolved): a
// `use_previous_value` parameter that is omitted yields no entry in the map,
// yet its `{ param: ... }` expression must still be stripped to `undefined` so
// the existing value is preserved rather than the raw expression being written
// as the new value.
export const resolveWorkingTemplate = (args: {
  template: FormationTemplate;
  parameters?: Record<string, string>;
}): FormationTemplate => {
  const { template, parameters } = args;
  const resolvedParamsMap = buildResolvedParamsMap(template, parameters);
  const hasParameters =
    !!template.parameters && Object.keys(template.parameters).length > 0;
  if (!hasParameters && resolvedParamsMap.size === 0) return template;
  return resolveParamExpressions(
    template,
    resolvedParamsMap,
    new Set(Object.keys(template.resources))
  ) as FormationTemplate;
};

const paramHasValue = (args: {
  decl: ParameterDeclaration | undefined;
  providedValue: string | undefined;
  forUpdate: boolean;
}): boolean => {
  const { decl, providedValue, forUpdate } = args;
  if (providedValue !== undefined && providedValue !== '') return true;
  if (decl?.default !== undefined) return true;
  // A `use_previous_value` parameter reuses its stored value, so it satisfies
  // the requirement without an explicit value — but only on update, where a
  // previous value exists. On create there is nothing to reuse.
  return forUpdate && decl?.use_previous_value === true;
};

export const getMissingParams = (
  template: FormationTemplate,
  provided?: Record<string, string>,
  forUpdate = false
): string[] => {
  const logicalIds = new Set(Object.keys(template.resources));
  const usedParams = new Set(
    [
      ...collectParamRefs(template.resources),
      ...collectParamRefs(template.outputs ?? {}),
    ].filter((name) => {
      // A sub token naming a resource logical id is a resource ref, not a param.
      return !logicalIds.has(name);
    })
  );

  return [...usedParams].filter((name) => {
    return !paramHasValue({
      decl: template.parameters?.[name],
      providedValue: provided?.[name],
      forUpdate,
    });
  });
};

// ── Dependency Graph ──────────────────────────────────────────────────────

export const buildDependencyGraph = (
  template: FormationTemplate
): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>();
  const logicalIds = new Set(Object.keys(template.resources));
  for (const [logicalId, decl] of Object.entries(template.resources)) {
    const deps = new Set<string>();
    for (const ref of collectRefs(decl.properties)) {
      if (ref !== logicalId) deps.add(ref);
    }
    for (const token of collectSubTokens(decl.properties)) {
      // Sub tokens naming other resources are implicit dependencies.
      if (token !== logicalId && logicalIds.has(token)) deps.add(token);
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

export const lookupToolInternalId = async (
  publicId: string
): Promise<number> => {
  const tool = await db.Tool.findOne({ where: { publicId } });
  if (!tool) throw new Error(`Tool not found: ${publicId}`);
  return (tool as unknown as { id: number }).id;
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
