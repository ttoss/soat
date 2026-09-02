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
const collectSubTokens = (value: unknown): string[] => {
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
    // An unresolved param drops the field, preserving the existing value. The
    // only way one reaches here unresolved is an explicit "use previous value"
    // — missing required params are rejected upstream.
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

// Placeholder written to `resolvedParameters` for `no_echo` parameters so a
// deploy's parameter set stays auditable without persisting the sensitive value.
const MASKED_PARAMETER_VALUE = '***';

/**
 * Builds the auditable record of parameter values applied at a deploy: declared
 * parameters resolved to their provided-or-default value, with `no_echo`
 * parameters masked. Parameters left unresolved (e.g. an omitted
 * `use_previous_value` parameter) are excluded. Returns null when there are no
 * recordable parameters.
 */
export const buildAuditableParameters = (
  template: FormationTemplate,
  provided?: Record<string, string>
): Record<string, string> | null => {
  if (!template.parameters) return null;
  const resolved = buildResolvedParamsMap(template, provided);
  const result: Record<string, string> = {};
  for (const [name, decl] of Object.entries(template.parameters)) {
    const value = resolved.get(name);
    if (value === undefined) continue;
    result[name] = decl.no_echo ? MASKED_PARAMETER_VALUE : value;
  }
  return Object.keys(result).length > 0 ? result : null;
};

// Runs whenever the template declares parameters, not only when values
// resolved: an omitted `use_previous_value` parameter yields no map entry, yet
// its expression must still be stripped so the existing value is preserved
// rather than the raw expression written as the new one.
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
      ...collectParamRefs(template.metadata ?? {}),
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

/**
 * Resolves a resource's public id to the internal primary key a lib argument
 * needs, or throws with the resource named.
 *
 * One body for every resource: the model and the noun are the only things that
 * vary, and the model types make an `as unknown as { id: number }` double cast
 * unnecessary.
 */
const lookupInternalId = async (args: {
  model: {
    findOne: (options: {
      where: { publicId: string; projectId: number };
    }) => Promise<{ id: number } | null>;
  };
  label: string;
  publicId: string;
  projectId: number;
}): Promise<number> => {
  const row = await args.model.findOne({
    where: { publicId: args.publicId, projectId: args.projectId },
  });
  // The same error a public id that does not exist at all raises, deliberately:
  // a distinguishable "exists, but elsewhere" would make this an oracle for ids
  // in other projects (#1180).
  if (!row) throw new Error(`${args.label} not found: ${args.publicId}`);
  return row.id;
};

/**
 * The project a lookup is confined to.
 *
 * `projectId` is **required** on every one of these: the REST routes resolve a
 * caller-supplied id with the project in the `where`, and the formation modules
 * resolved it on the public id alone — so a template deployed into project A
 * could name project B's `sec_…` and get a provider in A holding B's credential
 * (#1180). Public ids appear in responses, traces and deploy logs, so they are
 * not an access boundary. Every call site is a module `create`/`update`, which
 * runs under a known project, so there is no case where the value is genuinely
 * unavailable.
 */
export type ScopedLookupArgs = { publicId: string; projectId: number };

export const lookupSecretInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({ model: db.Secret, label: 'Secret', ...args });
};

export const lookupMemoryInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({ model: db.Memory, label: 'Memory', ...args });
};

export const lookupActorInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({ model: db.Actor, label: 'Actor', ...args });
};

export const lookupAgentInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({ model: db.Agent, label: 'Agent', ...args });
};

export const lookupToolInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({ model: db.Tool, label: 'Tool', ...args });
};

export const lookupPolicyInternalIds = async (
  publicIds: string[]
): Promise<number[]> => {
  if (publicIds.length === 0) return [];
  const policies = await db.Policy.findAll({ where: { publicId: publicIds } });
  if (policies.length !== publicIds.length) {
    const foundIds = new Set(
      policies.map((policy) => {
        return policy.publicId;
      })
    );
    const missing = publicIds.find((id) => {
      return !foundIds.has(id);
    });
    throw new Error(`Policy not found: ${missing}`);
  }
  return policies.map((policy) => {
    return policy.id;
  });
};
