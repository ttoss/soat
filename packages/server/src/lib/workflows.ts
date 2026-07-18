import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import {
  assertDispatchTargetsValid,
  assertWorkflowValid,
  type WorkflowState,
  type WorkflowTransition,
} from './workflowsValidation';

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

export const mapWorkflow = (instance: WorkflowInstance) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    name: instance.name,
    description: instance.description,
    states: instance.states,
    transitions: instance.transitions,
    payloadSchema: instance.payloadSchema,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

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

export const listWorkflows = async (args: { projectIds: number[] }) => {
  log('listWorkflows: projectIds=%o', args.projectIds);
  const workflows = await db.Workflow.findAll({
    where: { projectId: args.projectIds },
    include: workflowIncludes(),
    order: [['createdAt', 'DESC']],
  });
  return workflows.map((w) => {
    return mapWorkflow(w);
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
};

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
    states: args.states,
    transitions: args.transitions,
    payloadSchema: args.payloadSchema ?? null,
  });
  log('createWorkflow: created id=%s', workflow.publicId);

  const created = await findWorkflowInstance({ id: workflow.publicId });
  return mapWorkflow(created!);
};

type UpdateWorkflowArgs = {
  id: string;
  name?: string;
  description?: string | null;
  states?: WorkflowState[];
  transitions?: WorkflowTransition[];
  payloadSchema?: object | null;
};

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

  await workflow.destroy();
};
