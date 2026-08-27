import createDebug from 'debug';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';

import { DomainError } from '../errors';
import {
  assertDispatchTargetsValid,
  assertWorkflowValid,
  workflowCollectionToSnake,
  type WorkflowState,
  type WorkflowTransition,
} from './workflowsValidation';
import {
  buildWorkflowConfigSnapshot,
  workflowVersionStore,
} from './workflowVersionSnapshot';

export type {
  OnCompleteRule,
  OnEnter,
  WorkflowDispatch,
  WorkflowState,
  WorkflowTransition,
} from './workflowsValidation';

const log = createDebug('soat:workflows');

type WorkflowInstance = InstanceType<(typeof db)['Workflow']> & {
  project?: InstanceType<(typeof db)['Project']>;
};

/**
 * The authorship a write attaches to the version it archives. Optional
 * throughout: a write with no request user behind it (a formation apply, an
 * internal repair) archives a version with a null author rather than none.
 */
export type WorkflowVersionAuthorship = {
  createdByUserId?: number | null;
  versionLabel?: string | null;
};

export const mapWorkflow = (instance: WorkflowInstance) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    name: instance.name,
    description: instance.description,
    version: instance.version,
    states: workflowCollectionToSnake(instance.states),
    transitions: workflowCollectionToSnake(instance.transitions),
    payload_schema: instance.payloadSchema,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export type MappedWorkflow = ReturnType<typeof mapWorkflow>;

const workflowIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const assertNameAvailable = async (args: {
  projectId: number;
  name: string;
}): Promise<void> => {
  const existing = await db.Workflow.findOne({
    where: { projectId: args.projectId, name: args.name },
  });
  if (existing) {
    throw new DomainError(
      'NAME_CONFLICT',
      `Workflow '${args.name}' already exists in this project.`,
      { name: args.name }
    );
  }
};

const findWorkflowInstance = async (args: { id: string }) => {
  return db.Workflow.findOne({
    where: { publicId: args.id },
    include: workflowIncludes(),
  });
};

export const listWorkflows = async (args: {
  projectIds: number[];
  limit?: number;
  offset?: number;
}) => {
  log('listWorkflows: projectIds=%o', args.projectIds);
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Workflow.findAndCountAll({
        where: { projectId: args.projectIds },
        include: workflowIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (w) => {
      return mapWorkflow(w);
    },
  });
};

export const findWorkflow = async (args: { id: string }) => {
  const workflow = await findWorkflowInstance({ id: args.id });
  return workflow ? mapWorkflow(workflow) : null;
};

export const getWorkflow = async (args: { id: string }) => {
  const workflow = await findWorkflow({ id: args.id });
  if (!workflow) {
    throw new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${args.id}' not found.`
    );
  }
  return workflow;
};

type CreateWorkflowArgs = {
  projectId: number;
  name: string;
  description?: string | null;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  payloadSchema?: object | null;
} & WorkflowVersionAuthorship;

export const createWorkflow = async (args: CreateWorkflowArgs) => {
  log(
    'createWorkflow: projectId=%d name=%s states=%d',
    args.projectId,
    args.name,
    args.states?.length ?? 0
  );

  assertWorkflowValid({ states: args.states, transitions: args.transitions });
  await assertDispatchTargetsValid({
    projectId: args.projectId,
    states: args.states,
  });
  await assertNameAvailable({ projectId: args.projectId, name: args.name });

  const workflow = await db.Workflow.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    version: 1,
    states: args.states,
    transitions: args.transitions,
    payloadSchema: args.payloadSchema ?? null,
  });
  log('createWorkflow: created id=%s', workflow.publicId);

  const created = await findWorkflowInstance({ id: workflow.publicId });
  const mapped = mapWorkflow(created!);

  // Version 1 is archived on create, so the very first task has a pinned state
  // machine to resolve rather than falling back to the live row.
  await workflowVersionStore.writeVersion({
    resourceDbId: workflow.id as number,
    version: 1,
    config: buildWorkflowConfigSnapshot(mapped),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
  });

  return mapped;
};

type UpdateWorkflowArgs = {
  id: string;
  name?: string;
  description?: string | null;
  states?: WorkflowState[];
  transitions?: WorkflowTransition[];
  payloadSchema?: object | null;
} & WorkflowVersionAuthorship;

const revalidateWorkflowUpdate = async (args: {
  workflow: InstanceType<(typeof db)['Workflow']>;
  states?: WorkflowState[];
  transitions?: WorkflowTransition[];
}): Promise<void> => {
  if (args.states === undefined && args.transitions === undefined) return;
  // Structural changes re-validate against the full (merged) definition — the
  // definition is the sole authority at fire time.
  const nextStates = (args.states ?? args.workflow.states) as WorkflowState[];
  const nextTransitions = (args.transitions ??
    args.workflow.transitions) as WorkflowTransition[];
  assertWorkflowValid({ states: nextStates, transitions: nextTransitions });
  await assertDispatchTargetsValid({
    projectId: args.workflow.projectId as number,
    states: nextStates,
  });
};

export const updateWorkflow = async (args: UpdateWorkflowArgs) => {
  log('updateWorkflow: id=%s', args.id);

  const workflow = await findWorkflowInstance({ id: args.id });
  if (!workflow) {
    throw new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${args.id}' not found.`
    );
  }

  await revalidateWorkflowUpdate({
    workflow,
    states: args.states,
    transitions: args.transitions,
  });

  // `save` mutates the instance in place, so this one reference yields both the
  // pre- and post-write config with no second query and no chance of the two
  // views disagreeing.
  const beforeConfig = buildWorkflowConfigSnapshot(mapWorkflow(workflow));

  if (args.name !== undefined && args.name !== workflow.name) {
    await assertNameAvailable({
      projectId: workflow.projectId as number,
      name: args.name,
    });
    workflow.name = args.name;
  }
  if (args.description !== undefined) workflow.description = args.description;
  if (args.states !== undefined) workflow.states = args.states;
  if (args.transitions !== undefined) workflow.transitions = args.transitions;
  if (args.payloadSchema !== undefined) {
    workflow.payloadSchema = args.payloadSchema;
  }

  await workflow.save();

  // A definition write bumps the version, so a task pinned to an earlier one
  // still resolves the machine it entered on. Metadata-only edits and
  // re-writing the identical definition leave it untouched — restoring the live
  // definition is a no-op, not a version chain.
  await workflowVersionStore.archiveConfigChange({
    resourceDbId: workflow.id as number,
    currentVersion: workflow.version,
    before: beforeConfig,
    after: buildWorkflowConfigSnapshot(mapWorkflow(workflow)),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
    bumpVersion: async (nextVersion) => {
      await workflow.update({ version: nextVersion });
      log('updateWorkflow: id=%s bumped to version=%d', args.id, nextVersion);
    },
  });

  const updated = await findWorkflowInstance({ id: args.id });
  return mapWorkflow(updated!);
};

export const deleteWorkflow = async (args: { id: string }) => {
  log('deleteWorkflow: id=%s', args.id);
  const workflow = await db.Workflow.findOne({ where: { publicId: args.id } });
  if (!workflow) {
    throw new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${args.id}' not found.`
    );
  }

  const openTasks = await db.Task.count({
    where: { workflowId: workflow.id as number, status: 'open' },
  });
  if (openTasks > 0) {
    throw new DomainError(
      'WORKFLOW_HAS_OPEN_TASKS',
      `Workflow '${args.id}' has ${openTasks} open task(s) and cannot be deleted.`,
      { openTasks }
    );
  }

  // Removed before the parent so no orphan version rows are left behind. Closed
  // tasks cascade with the workflow, so nothing stays pinned to a version that
  // no longer exists.
  await db.sequelize.transaction(async (t) => {
    await workflowVersionStore.deleteVersions({
      resourceDbId: workflow.id as number,
      transaction: t,
    });
    await workflow.destroy({ transaction: t });
  });
};
