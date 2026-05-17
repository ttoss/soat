import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';

import {
  applyFormationTemplate,
  buildDeleteOrder,
  performResourceDeletions,
} from './agentFormationsApply';
import {
  buildDependencyGraph,
  topologicalSort,
} from './agentFormationsHelpers';
import type {
  FormationEvent,
  FormationTemplate,
  MappedAgentFormation,
  MappedAgentFormationResource,
  MappedFormationOperation,
  PlanChange,
  PlanResult,
} from './agentFormationsTypes';

export type {
  FormationEvent,
  FormationTemplate,
  MappedAgentFormation,
  MappedAgentFormationResource,
  MappedFormationOperation,
  PlanChange,
  PlanResult,
} from './agentFormationsTypes';
export {
  parseFormationTemplateInput,
  validateFormationTemplate,
} from './agentFormationsValidation';

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

// ── Public API ────────────────────────────────────────────────────────────

export const planAgentFormation = async (args: {
  projectId: number;
  template: FormationTemplate;
  formationId?: string;
}): Promise<PlanResult> => {
  const graph = buildDependencyGraph(args.template);
  const sortedOrder = topologicalSort(graph) ?? [];

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

  const orderedResources = buildDeleteOrder(
    formation.template as FormationTemplate | null,
    existingResources
  );
  const { events, hasError } = await performResourceDeletions(orderedResources);

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
