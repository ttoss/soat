import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';

import { createAgent, deleteAgent } from './agents';
import {
  createAgentTool,
  deleteAgentTool,
  updateAgentTool,
} from './agentToolsCrud';
import {
  createAiProvider,
  deleteAiProvider,
  updateAiProvider,
} from './aiProviders';
import { createDocument, deleteDocument } from './documents';
import { createMemory, deleteMemory, updateMemory } from './memories';
import { createMemoryEntry, deleteMemoryEntry } from './memoryEntries';
import { createWebhook, deleteWebhook, updateWebhook } from './webhooks';

// ── Template Types ────────────────────────────────────────────────────────

export type RefExpression = { ref: string };

export type ResourceDeclaration = {
  type: string;
  properties: Record<string, unknown>;
  depends_on?: string[];
  metadata?: Record<string, unknown>;
};

export type FormationTemplate = {
  resources: Record<string, ResourceDeclaration>;
  outputs?: Record<string, RefExpression | unknown>;
  metadata?: Record<string, unknown>;
};

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
};

export type PlanChange = {
  logicalId: string;
  resourceType: string;
  action: 'create' | 'update' | 'delete' | 'no-op';
};

export type PlanResult = {
  changes: PlanChange[];
};

export type FormationEvent = {
  timestamp: string;
  logicalId: string;
  resourceType: string;
  action: string;
  status: 'succeeded' | 'failed';
  physicalResourceId?: string;
  error?: string;
};

// ── Mapped Types ──────────────────────────────────────────────────────────

export type MappedAgentFormationResource = {
  id: string;
  logicalId: string;
  resourceType: string;
  physicalResourceId: string | null;
  status: string;
};

export type MappedAgentFormation = {
  id: string;
  projectId: string;
  name: string;
  template: FormationTemplate | null;
  outputs: Record<string, string> | null;
  status: string;
  metadata: Record<string, unknown> | null;
  resources?: MappedAgentFormationResource[];
  createdAt: Date;
  updatedAt: Date;
};

export type MappedFormationOperation = {
  id: string;
  operationType: string;
  status: string;
  events: FormationEvent[] | null;
  plan: PlanResult | null;
  error: object | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Supported Resource Types ──────────────────────────────────────────────

const SUPPORTED_RESOURCE_TYPES = new Set([
  'ai_provider',
  'agent_tool',
  'agent',
  'document',
  'memory',
  'memory_entry',
  'webhook',
]);

// ── Ref Utilities ─────────────────────────────────────────────────────────

const isRef = (value: unknown): value is RefExpression => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'ref' in value &&
    typeof (value as Record<string, unknown>).ref === 'string'
  );
};

/**
 * Collect all ref targets in a value recursively.
 */
const collectRefs = (value: unknown): string[] => {
  if (isRef(value)) return [value.ref];
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(collectRefs);
  }
  return [];
};

/**
 * Resolve all { ref: "logicalId" } expressions in a value,
 * replacing them with the physical resource ID from the resolvedIds map.
 */
const resolveRefs = (
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

/**
 * Build adjacency map: logicalId → Set of logicalIds it depends on.
 */
const buildDependencyGraph = (
  template: FormationTemplate
): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>();
  for (const [logicalId, decl] of Object.entries(template.resources)) {
    const deps = new Set<string>();
    // Implicit refs from properties
    for (const ref of collectRefs(decl.properties)) {
      if (ref !== logicalId) deps.add(ref);
    }
    // Explicit depends_on
    for (const dep of decl.depends_on ?? []) {
      if (dep !== logicalId) deps.add(dep);
    }
    graph.set(logicalId, deps);
  }
  return graph;
};

/**
 * Topological sort (Kahn's algorithm).
 * Returns sorted order or null if a cycle exists.
 */
const topologicalSort = (graph: Map<string, Set<string>>): string[] | null => {
  // Kahn's algorithm: graph[node] = set of nodes that `node` depends on.
  // Start with nodes that have no dependencies (dep count = 0).
  // Each step, output such a node and remove it as a dependency from others.
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
    // Reduce dep count for all nodes that depended on `node`
    for (const [other, deps] of graph.entries()) {
      if (deps.has(node)) {
        const newCount = (depCount.get(other) ?? 1) - 1;
        depCount.set(other, newCount);
        if (newCount === 0) queue.push(other);
      }
    }
  }

  if (sorted.length !== graph.size) return null; // cycle detected
  return sorted;
};

// ── Template Validation ───────────────────────────────────────────────────

export const validateFormationTemplate = (
  template: unknown
): ValidationResult => {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (
    typeof template !== 'object' ||
    template === null ||
    Array.isArray(template)
  ) {
    errors.push({ path: '', message: 'Template must be an object' });
    return { valid: false, errors, warnings };
  }

  const tmpl = template as Record<string, unknown>;

  if (
    !tmpl.resources ||
    typeof tmpl.resources !== 'object' ||
    Array.isArray(tmpl.resources)
  ) {
    errors.push({
      path: 'resources',
      message: '`resources` must be an object',
    });
    return { valid: false, errors, warnings };
  }

  const resources = tmpl.resources as Record<string, unknown>;
  const logicalIds = new Set(Object.keys(resources));

  for (const [logicalId, declRaw] of Object.entries(resources)) {
    const basePath = `resources.${logicalId}`;

    if (
      typeof declRaw !== 'object' ||
      declRaw === null ||
      Array.isArray(declRaw)
    ) {
      errors.push({
        path: basePath,
        message: 'Resource declaration must be an object',
      });
      continue;
    }

    const decl = declRaw as Record<string, unknown>;

    if (!decl.type || typeof decl.type !== 'string') {
      errors.push({
        path: `${basePath}.type`,
        message: '`type` is required and must be a string',
      });
    } else if (!SUPPORTED_RESOURCE_TYPES.has(decl.type)) {
      errors.push({
        path: `${basePath}.type`,
        message: `Unsupported resource type: ${decl.type}. Supported: ${[...SUPPORTED_RESOURCE_TYPES].join(', ')}`,
      });
    }

    if (
      !decl.properties ||
      typeof decl.properties !== 'object' ||
      Array.isArray(decl.properties)
    ) {
      errors.push({
        path: `${basePath}.properties`,
        message: '`properties` is required and must be an object',
      });
    }

    // Validate refs
    const refs = collectRefs(decl.properties ?? {});
    for (const ref of refs) {
      if (!logicalIds.has(ref)) {
        errors.push({
          path: `${basePath}.properties`,
          message: `Referenced resource '${ref}' does not exist in template`,
        });
      }
    }

    // Validate explicit depends_on
    if (decl.depends_on !== undefined) {
      if (!Array.isArray(decl.depends_on)) {
        errors.push({
          path: `${basePath}.depends_on`,
          message: '`depends_on` must be an array',
        });
      } else {
        for (const dep of decl.depends_on as unknown[]) {
          if (typeof dep !== 'string') {
            errors.push({
              path: `${basePath}.depends_on`,
              message: 'Each depends_on entry must be a string',
            });
          } else if (!logicalIds.has(dep)) {
            errors.push({
              path: `${basePath}.depends_on`,
              message: `depends_on references unknown resource '${dep}'`,
            });
          }
        }
      }
    }
  }

  // Validate output refs
  if (
    tmpl.outputs &&
    typeof tmpl.outputs === 'object' &&
    !Array.isArray(tmpl.outputs)
  ) {
    for (const [outputName, outputValue] of Object.entries(
      tmpl.outputs as Record<string, unknown>
    )) {
      const refs = collectRefs(outputValue);
      for (const ref of refs) {
        if (!logicalIds.has(ref)) {
          errors.push({
            path: `outputs.${outputName}`,
            message: `Referenced resource '${ref}' does not exist in template`,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Build dependency graph and check for cycles
  const castTemplate = template as FormationTemplate;
  const graph = buildDependencyGraph(castTemplate);
  const sorted = topologicalSort(graph);
  if (!sorted) {
    errors.push({
      path: 'resources',
      message: 'Circular dependency detected in resources',
    });
    return { valid: false, errors, warnings };
  }

  return { valid: true, errors, warnings };
};

// ── Internal ID Lookups ───────────────────────────────────────────────────

const lookupSecretInternalId = async (publicId: string): Promise<number> => {
  const secret = await db.Secret.findOne({ where: { publicId } });
  if (!secret) throw new Error(`Secret not found: ${publicId}`);
  return (secret as unknown as { id: number }).id;
};

const lookupMemoryInternalId = async (publicId: string): Promise<number> => {
  const memory = await db.Memory.findOne({ where: { publicId } });
  if (!memory) throw new Error(`Memory not found: ${publicId}`);
  return (memory as unknown as { id: number }).id;
};

// ── Resource Apply Handlers ───────────────────────────────────────────────

type ApplyArgs = {
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  projectId: number;
};

const applyCreateResource = async (args: ApplyArgs): Promise<string> => {
  const { resourceType, resolvedProperties: p, projectId } = args;

  switch (resourceType) {
    case 'ai_provider': {
      let secretId: number | undefined;
      if (p.secret_id && typeof p.secret_id === 'string') {
        secretId = await lookupSecretInternalId(p.secret_id);
      }
      const created = await createAiProvider({
        projectId,
        secretId,
        name: p.name as string,
        provider: p.provider as Parameters<
          typeof createAiProvider
        >[0]['provider'],
        defaultModel: p.default_model as string,
        baseUrl: p.base_url as string | undefined,
        config: p.config as Record<string, unknown> | undefined,
      });
      return created.id;
    }

    case 'agent_tool': {
      const created = await createAgentTool({
        projectId,
        type: p.type as string | undefined,
        name: p.name as string,
        description: p.description as string | undefined,
        parameters: p.parameters as object | undefined,
        execute: p.execute as object | undefined,
        mcp: p.mcp as object | undefined,
        actions: p.actions as string[] | undefined,
        presetParameters: p.preset_parameters as object | undefined,
      });
      return created.id;
    }

    case 'agent': {
      const created = await createAgent({
        projectId,
        aiProviderId: p.ai_provider_id as string,
        name: p.name as string | undefined,
        instructions: p.instructions as string | undefined,
        model: p.model as string | undefined,
        toolIds: p.tool_ids as string[] | undefined,
        maxSteps: p.max_steps as number | undefined,
        toolChoice: p.tool_choice as object | undefined,
        stopConditions: p.stop_conditions as object[] | undefined,
        activeToolIds: p.active_tool_ids as string[] | undefined,
        stepRules: p.step_rules as object[] | undefined,
        boundaryPolicy: p.boundary_policy as object | undefined,
        temperature: p.temperature as number | undefined,
        knowledgeConfig: p.knowledge_config as object | undefined,
      });
      if (created === 'ai_provider_not_found') {
        throw new Error(`AI provider not found: ${p.ai_provider_id}`);
      }
      return created.id;
    }

    case 'document': {
      const created = await createDocument({
        projectId,
        content: p.content as string,
        path: p.path as string | undefined,
        filename: p.filename as string | undefined,
        title: p.title as string | undefined,
        metadata: p.metadata as Record<string, unknown> | undefined,
        tags: p.tags as Record<string, string> | undefined,
      });
      return created.id;
    }

    case 'memory': {
      const created = await createMemory({
        projectId,
        name: p.name as string,
        description: p.description as string | undefined,
        tags: p.tags as string[] | undefined,
      });
      return created.id;
    }

    case 'memory_entry': {
      const memoryInternalId = await lookupMemoryInternalId(
        p.memory_id as string
      );
      const created = await createMemoryEntry({
        memoryId: memoryInternalId,
        content: p.content as string,
        source: p.source as Parameters<typeof createMemoryEntry>[0]['source'],
      });
      return created.id;
    }

    case 'webhook': {
      const created = await createWebhook({
        projectId,
        name: p.name as string,
        description: p.description as string | undefined,
        url: p.url as string,
        events: p.events as string[],
      });
      return created.id;
    }

    default:
      throw new Error(`Unsupported resource type: ${resourceType}`);
  }
};

const applyUpdateResource = async (args: {
  resourceType: string;
  physicalResourceId: string;
  resolvedProperties: Record<string, unknown>;
}): Promise<void> => {
  const { resourceType, physicalResourceId, resolvedProperties: p } = args;

  switch (resourceType) {
    case 'ai_provider': {
      let secretId: number | undefined;
      if (p.secret_id && typeof p.secret_id === 'string') {
        secretId = await lookupSecretInternalId(p.secret_id);
      }
      await updateAiProvider({
        id: physicalResourceId,
        secretId,
        name: p.name as string | undefined,
        provider: p.provider as Parameters<
          typeof updateAiProvider
        >[0]['provider'],
        defaultModel: p.default_model as string | undefined,
        baseUrl: p.base_url as string | null | undefined,
        config: p.config as Record<string, unknown> | null | undefined,
      });
      break;
    }

    case 'agent_tool': {
      await updateAgentTool({
        id: physicalResourceId,
        name: p.name as string | undefined,
        description: p.description as string | null | undefined,
        parameters: p.parameters as object | null | undefined,
        execute: p.execute as object | null | undefined,
        mcp: p.mcp as object | null | undefined,
        actions: p.actions as string[] | null | undefined,
        presetParameters: p.preset_parameters as object | null | undefined,
      });
      break;
    }

    case 'agent': {
      const instance = await db.Agent.findOne({
        where: { publicId: physicalResourceId },
      });
      if (!instance) throw new Error(`Agent not found: ${physicalResourceId}`);
      if (p.name !== undefined) instance.name = p.name as string;
      if (p.instructions !== undefined)
        instance.instructions = p.instructions as string;
      if (p.model !== undefined) instance.model = p.model as string;
      if (p.tool_ids !== undefined) instance.toolIds = p.tool_ids as string[];
      if (p.max_steps !== undefined) instance.maxSteps = p.max_steps as number;
      if (p.tool_choice !== undefined)
        instance.toolChoice = p.tool_choice as object;
      if (p.stop_conditions !== undefined)
        instance.stopConditions = p.stop_conditions as object[];
      if (p.active_tool_ids !== undefined)
        instance.activeToolIds = p.active_tool_ids as string[];
      if (p.step_rules !== undefined)
        instance.stepRules = p.step_rules as object[];
      if (p.boundary_policy !== undefined)
        instance.boundaryPolicy = p.boundary_policy as object;
      if (p.temperature !== undefined)
        instance.temperature = p.temperature as number;
      if (p.knowledge_config !== undefined)
        instance.knowledgeConfig = p.knowledge_config as object;
      await instance.save();
      break;
    }

    case 'memory': {
      await updateMemory({
        id: physicalResourceId,
        name: p.name as string | undefined,
        description: p.description as string | null | undefined,
        tags: p.tags as string[] | null | undefined,
      });
      break;
    }

    case 'memory_entry': {
      const entry = await db.MemoryEntry.findOne({
        where: { publicId: physicalResourceId },
      });
      if (!entry)
        throw new Error(`MemoryEntry not found: ${physicalResourceId}`);
      if (p.content !== undefined) {
        entry.content = p.content as string;
        await entry.save();
      }
      break;
    }

    case 'webhook': {
      await updateWebhook({
        id: physicalResourceId,
        name: p.name as string | undefined,
        description: p.description as string | undefined,
        url: p.url as string | undefined,
        events: p.events as string[] | undefined,
      });
      break;
    }

    case 'document':
      // Documents have content embedded — treat as no-op for update
      break;

    default:
      throw new Error(`Unsupported resource type for update: ${resourceType}`);
  }
};

const applyDeleteResource = async (args: {
  resourceType: string;
  physicalResourceId: string;
}): Promise<void> => {
  const { resourceType, physicalResourceId } = args;

  switch (resourceType) {
    case 'ai_provider':
      await deleteAiProvider({ id: physicalResourceId });
      break;
    case 'agent_tool':
      await deleteAgentTool({ id: physicalResourceId });
      break;
    case 'agent':
      await deleteAgent({ id: physicalResourceId });
      break;
    case 'document':
      await deleteDocument({ id: physicalResourceId });
      break;
    case 'memory':
      await deleteMemory({ id: physicalResourceId });
      break;
    case 'memory_entry':
      await deleteMemoryEntry({ id: physicalResourceId });
      break;
    case 'webhook':
      await deleteWebhook({ id: physicalResourceId });
      break;
    default:
      throw new Error(`Unsupported resource type for delete: ${resourceType}`);
  }
};

// ── Mapping ───────────────────────────────────────────────────────────────

const mapFormation = (
  instance: InstanceType<(typeof db)['AgentFormation']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agentFormationResources?: InstanceType<
      (typeof db)['AgentFormationResource']
    >[];
  },
  includeResources = false
): MappedAgentFormation => {
  const resources: MappedAgentFormationResource[] | undefined = includeResources
    ? (instance.agentFormationResources ?? []).map((r) => {
        return {
          id: r.publicId,
          logicalId: r.logicalId,
          resourceType: r.resourceType,
          physicalResourceId: r.physicalResourceId,
          status: r.status,
        };
      })
    : undefined;

  return {
    id: instance.publicId,
    projectId: instance.project?.publicId ?? '',
    name: instance.name,
    template: instance.template as FormationTemplate | null,
    outputs: instance.outputs,
    status: instance.status,
    metadata: instance.metadata,
    ...(resources !== undefined ? { resources } : {}),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

const getFormationIncludes = (includeResources = false) => {
  const includes: object[] = [{ model: db.Project, as: 'project' }];
  if (includeResources) {
    includes.push({
      model: db.AgentFormationResource,
      as: 'agentFormationResources',
    });
  }
  return includes;
};

// ── Apply Logic ───────────────────────────────────────────────────────────

const applyFormationTemplate = async (args: {
  formation: InstanceType<(typeof db)['AgentFormation']>;
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['AgentFormationResource']>[];
  projectId: number;
  operation: InstanceType<(typeof db)['AgentFormationOperation']>;
}): Promise<void> => {
  const { formation, template, existingResources, projectId, operation } = args;

  const graph = buildDependencyGraph(template);
  const sortedOrder = topologicalSort(graph)!;

  // Map logicalId → existing resource row
  const existingMap = new Map(
    existingResources.map((r) => {
      return [r.logicalId, r];
    })
  );

  // Track resolved physical IDs: logicalId → publicId
  const resolvedIds = new Map<string, string>();

  // Seed resolved IDs from existing resources that won't change
  for (const [lid, existing] of existingMap.entries()) {
    if (existing.physicalResourceId && template.resources[lid]) {
      resolvedIds.set(lid, existing.physicalResourceId);
    }
  }

  const events: FormationEvent[] = [];

  // Process resources in topological order
  for (const logicalId of sortedOrder) {
    const decl = template.resources[logicalId];
    const existing = existingMap.get(logicalId);

    const resolvedProperties = resolveRefs(
      decl.properties,
      resolvedIds
    ) as Record<string, unknown>;

    let resourceRow: InstanceType<(typeof db)['AgentFormationResource']>;

    if (!existing) {
      // Create new resource row
      resourceRow = await db.AgentFormationResource.create({
        agentFormationId: (formation as unknown as { id: number }).id,
        logicalId,
        resourceType: decl.type,
        status: 'pending',
        physicalResourceId: null,
        lastAppliedProperties: null,
      });
    } else {
      resourceRow = existing;
    }

    try {
      if (!existing || !existing.physicalResourceId) {
        // Create
        const physicalId = await applyCreateResource({
          resourceType: decl.type,
          resolvedProperties,
          projectId,
        });
        resolvedIds.set(logicalId, physicalId);
        await resourceRow.update({
          physicalResourceId: physicalId,
          status: 'created',
          lastAppliedProperties: resolvedProperties,
        });
        events.push({
          timestamp: new Date().toISOString(),
          logicalId,
          resourceType: decl.type,
          action: 'create',
          status: 'succeeded',
          physicalResourceId: physicalId,
        });
      } else {
        // Check if update is needed
        const lastProps = (existing.lastAppliedProperties ?? {}) as Record<
          string,
          unknown
        >;
        const propertiesChanged =
          JSON.stringify(lastProps) !== JSON.stringify(resolvedProperties);

        resolvedIds.set(logicalId, existing.physicalResourceId);

        if (propertiesChanged) {
          await applyUpdateResource({
            resourceType: decl.type,
            physicalResourceId: existing.physicalResourceId,
            resolvedProperties,
          });
          await resourceRow.update({
            status: 'updated',
            lastAppliedProperties: resolvedProperties,
          });
          events.push({
            timestamp: new Date().toISOString(),
            logicalId,
            resourceType: decl.type,
            action: 'update',
            status: 'succeeded',
            physicalResourceId: existing.physicalResourceId,
          });
        } else {
          events.push({
            timestamp: new Date().toISOString(),
            logicalId,
            resourceType: decl.type,
            action: 'no-op',
            status: 'succeeded',
            physicalResourceId: existing.physicalResourceId,
          });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await resourceRow.update({ status: 'failed' });
      events.push({
        timestamp: new Date().toISOString(),
        logicalId,
        resourceType: decl.type,
        action: existing ? 'update' : 'create',
        status: 'failed',
        error: errorMsg,
      });
      await operation.update({
        status: 'failed',
        events,
        error: { message: errorMsg, logicalId },
      });
      await formation.update({ status: 'failed' });
      return;
    }
  }

  // Handle deleted resources (present in existing but not in new template)
  const newLogicalIds = new Set(Object.keys(template.resources));
  const toDelete = existingResources.filter((r) => {
    return !newLogicalIds.has(r.logicalId) && r.physicalResourceId;
  });

  // Delete in reverse topological order (no guaranteed order for orphaned, just delete them)
  for (const resource of toDelete) {
    try {
      await applyDeleteResource({
        resourceType: resource.resourceType,
        physicalResourceId: resource.physicalResourceId!,
      });
      await resource.update({ status: 'deleted' });
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'succeeded',
        physicalResourceId: resource.physicalResourceId ?? undefined,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'failed',
        error: errorMsg,
      });
    }
  }

  // Resolve outputs
  const outputs: Record<string, string> = {};
  if (template.outputs) {
    for (const [outputName, outputValue] of Object.entries(template.outputs)) {
      try {
        const resolved = resolveRefs(outputValue, resolvedIds);
        if (typeof resolved === 'string') {
          outputs[outputName] = resolved;
        }
      } catch {
        // Skip unresolvable outputs
      }
    }
  }

  await operation.update({ status: 'succeeded', events });
  await formation.update({
    status: 'active',
    outputs,
    template,
  });
};

// ── Public API ────────────────────────────────────────────────────────────

export const planAgentFormation = async (args: {
  projectId: number;
  template: FormationTemplate;
  formationId?: string;
}): Promise<PlanResult> => {
  const graph = buildDependencyGraph(args.template);
  const sortedOrder = topologicalSort(graph) ?? [];

  // Load existing resources if updating
  const existingMap = new Map<string, string>();
  if (args.formationId) {
    const formation = await db.AgentFormation.findOne({
      where: { publicId: args.formationId },
    });
    if (formation) {
      const existingResources = await db.AgentFormationResource.findAll({
        where: {
          agentFormationId: (formation as unknown as { id: number }).id,
        },
      });
      for (const r of existingResources) {
        if (r.physicalResourceId)
          existingMap.set(r.logicalId, r.physicalResourceId);
      }
    }
  }

  const changes: PlanChange[] = sortedOrder.map((logicalId) => {
    const decl = args.template.resources[logicalId];
    const exists = existingMap.has(logicalId);
    return {
      logicalId,
      resourceType: decl.type,
      action: exists ? 'update' : 'create',
    };
  });

  return { changes };
};

export const createAgentFormation = async (args: {
  projectId: number;
  name: string;
  template: FormationTemplate;
  metadata?: Record<string, unknown>;
}): Promise<MappedAgentFormation | 'name_conflict'> => {
  // Check uniqueness
  const existing = await db.AgentFormation.findOne({
    where: { projectId: args.projectId, name: args.name },
  });
  if (existing) return 'name_conflict';

  const formation = await db.AgentFormation.create({
    projectId: args.projectId,
    name: args.name,
    template: args.template,
    outputs: null,
    status: 'creating',
    metadata: args.metadata ?? null,
  });

  const operation = await db.AgentFormationOperation.create({
    agentFormationId: (formation as unknown as { id: number }).id,
    operationType: 'create',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  await applyFormationTemplate({
    formation,
    template: args.template,
    existingResources: [],
    projectId: args.projectId,
    operation,
  });

  const refreshed = await db.AgentFormation.findOne({
    where: { id: (formation as unknown as { id: number }).id },
    include: getFormationIncludes(true),
  });

  return mapFormation(
    refreshed as unknown as Parameters<typeof mapFormation>[0],
    true
  );
};

export const listAgentFormations = async (args: {
  projectIds: number[];
}): Promise<MappedAgentFormation[]> => {
  const formations = await db.AgentFormation.findAll({
    where: { projectId: args.projectIds },
    include: getFormationIncludes(),
    order: [['createdAt', 'ASC']],
  });

  return formations.map((f) => {
    return mapFormation(f as unknown as Parameters<typeof mapFormation>[0]);
  });
};

export const getAgentFormation = async (args: {
  id: string;
}): Promise<MappedAgentFormation | null> => {
  const formation = await db.AgentFormation.findOne({
    where: { publicId: args.id, status: { [Op.ne]: 'deleted' } },
    include: getFormationIncludes(true),
  });
  if (!formation) return null;
  return mapFormation(
    formation as unknown as Parameters<typeof mapFormation>[0],
    true
  );
};

export const updateAgentFormation = async (args: {
  id: string;
  template?: FormationTemplate;
  metadata?: Record<string, unknown> | null;
}): Promise<MappedAgentFormation | null> => {
  const formation = await db.AgentFormation.findOne({
    where: { publicId: args.id },
  });
  if (!formation) return null;

  const newTemplate =
    args.template ?? (formation.template as FormationTemplate);

  const operation = await db.AgentFormationOperation.create({
    agentFormationId: (formation as unknown as { id: number }).id,
    operationType: 'update',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  await formation.update({ status: 'updating' });
  if (args.metadata !== undefined) {
    await formation.update({ metadata: args.metadata });
  }

  const existingResources = await db.AgentFormationResource.findAll({
    where: { agentFormationId: (formation as unknown as { id: number }).id },
  });

  await applyFormationTemplate({
    formation,
    template: newTemplate,
    existingResources,
    projectId: formation.projectId,
    operation,
  });

  const refreshed = await db.AgentFormation.findOne({
    where: { id: (formation as unknown as { id: number }).id },
    include: getFormationIncludes(true),
  });

  return mapFormation(
    refreshed as unknown as Parameters<typeof mapFormation>[0],
    true
  );
};

export const deleteAgentFormation = async (args: {
  id: string;
}): Promise<{ success: boolean } | null> => {
  const formation = await db.AgentFormation.findOne({
    where: { publicId: args.id },
  });
  if (!formation) return null;

  await formation.update({ status: 'deleting' });

  const operation = await db.AgentFormationOperation.create({
    agentFormationId: (formation as unknown as { id: number }).id,
    operationType: 'delete',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  const existingResources = await db.AgentFormationResource.findAll({
    where: { agentFormationId: (formation as unknown as { id: number }).id },
  });

  // Delete in reverse topological order
  const template = formation.template as FormationTemplate | null;
  let deleteOrder: string[] = [];
  if (template?.resources) {
    const graph = buildDependencyGraph(template);
    const sorted = topologicalSort(graph);
    if (sorted) {
      deleteOrder = [...sorted].reverse();
    }
  }

  // Build a map for ordered deletion
  const resourceMap = new Map(
    existingResources.map((r) => {
      return [r.logicalId, r];
    })
  );
  const orderedResources: InstanceType<
    (typeof db)['AgentFormationResource']
  >[] = [];

  for (const logicalId of deleteOrder) {
    const r = resourceMap.get(logicalId);
    if (r) orderedResources.push(r);
  }
  // Add any resources not in the template (orphans)
  for (const r of existingResources) {
    if (!deleteOrder.includes(r.logicalId)) {
      orderedResources.push(r);
    }
  }

  const events: FormationEvent[] = [];
  let hasError = false;

  for (const resource of orderedResources) {
    if (!resource.physicalResourceId) continue;
    try {
      await applyDeleteResource({
        resourceType: resource.resourceType,
        physicalResourceId: resource.physicalResourceId,
      });
      await resource.update({ status: 'deleted' });
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'succeeded',
        physicalResourceId: resource.physicalResourceId,
      });
    } catch (error) {
      hasError = true;
      const errorMsg = error instanceof Error ? error.message : String(error);
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'failed',
        error: errorMsg,
      });
    }
  }

  if (hasError) {
    await operation.update({ status: 'failed', events });
    await formation.update({ status: 'delete_failed' });
    return { success: false };
  }

  await operation.update({ status: 'succeeded', events });
  await formation.update({ status: 'deleted' });
  return { success: true };
};

export const listAgentFormationEvents = async (args: {
  formationId: string;
}): Promise<MappedFormationOperation[]> => {
  const formation = await db.AgentFormation.findOne({
    where: { publicId: args.formationId },
  });
  if (!formation) return [];

  const operations = await db.AgentFormationOperation.findAll({
    where: { agentFormationId: (formation as unknown as { id: number }).id },
    order: [['createdAt', 'ASC']],
  });

  return operations.map((op) => {
    return {
      id: op.publicId,
      operationType: op.operationType,
      status: op.status,
      events: op.events as FormationEvent[] | null,
      plan: op.plan as PlanResult | null,
      error: op.error,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    };
  });
};
