import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type ArchivedVersionRow,
  configObject,
  makeVersionArchive,
  mapArchivedVersionFields,
  type VersionedResourceRef,
} from './resourceVersions';
import {
  type MappedWorkflow,
  updateWorkflow,
  type WorkflowState,
  type WorkflowTransition,
} from './workflows';
import { workflowCollectionToCamel } from './workflowsWire';
import { workflowVersionStore } from './workflowVersionSnapshot';

const log = createDebug('soat:workflows');

/**
 * Workflow state-machine version history (issue #882).
 *
 * The archive mechanics live in `resourceVersions.ts` and are shared with agents,
 * guardrails and orchestrations; this module supplies the workflow-specific
 * adapters. Versions are never written from here — they are archived by the
 * shared write path in `workflows.ts`, so a REST edit and a formation apply leave
 * identical history.
 *
 * Workflows have no release/canary layer: a task is pinned at creation and stays
 * on that version for its whole life, which can be weeks. A workflow release
 * would mean "the version new tasks are created into", with no mid-life
 * reassignment (#877); nothing has asked for it (#883), and the mechanism is
 * already extracted and pure in `releaseAssignment.ts` for when something does.
 */

type WorkflowInstance = InstanceType<(typeof db)['Workflow']>;

// ── Mapping ──────────────────────────────────────────────────────────────

export const mapWorkflowVersion = (
  version: ArchivedVersionRow,
  workflowPublicId: string
) => {
  return {
    workflow_id: workflowPublicId,
    ...mapArchivedVersionFields(version),
  };
};

// ── Lookup helpers ───────────────────────────────────────────────────────

/**
 * Deliberately unscoped by project, unlike the orchestration archive's lookup:
 * every workflow route — these three included — resolves the workflow first and
 * then authorizes the action against its SRN (`rest/v1/workflows.ts`), so a
 * `projectIds` filter here would be a second, never-exercised access check.
 */
const findWorkflowInstance = async (args: {
  id: string;
}): Promise<WorkflowInstance> => {
  const workflow = await db.Workflow.findOne({
    where: { publicId: args.id },
  });
  /* istanbul ignore next -- the router resolves the workflow (and answers 404)
     before the archive runs, so only a delete racing between those two lookups
     reaches this. It stays because the archive must not be reachable with a
     dangling id through any future caller. */
  if (!workflow) {
    throw new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${args.id}' not found.`
    );
  }
  return workflow as WorkflowInstance;
};

/**
 * An archived `states` / `transitions` collection, converted back to the
 * internal camelCase shape.
 *
 * The empty-array fallback is unreachable: the archive is only ever written from
 * `buildWorkflowConfigSnapshot`, whose mapper emits an array for both keys. It
 * exists because a version replaces the **whole** definition, so an unreadable
 * collection must mean "empty" and never "leave as is" — which is what passing
 * `undefined` to `updateWorkflow` would mean.
 */
/* istanbul ignore next -- see above: no write path can produce the fallback. */
const archivedCollection = <T>(value: unknown): T[] => {
  return workflowCollectionToCamel<T>(value) ?? [];
};

const toResourceRef = (workflow: WorkflowInstance): VersionedResourceRef => {
  return {
    dbId: workflow.id as number,
    publicId: workflow.publicId,
    version: workflow.version,
  };
};

/**
 * The workflow adapter over the shared archive. `applyConfig` routes through
 * `updateWorkflow` rather than touching columns, so a restored definition goes
 * through the same static validation as an authored one and is archived by the
 * same choke point as any other edit — and a definition identical to the live one
 * is recognised as a no-op.
 *
 * Unlike an orchestration graph, that validation *can* start failing over time:
 * `assertDispatchTargetsValid` resolves every `on_enter` dispatch target when the
 * definition is written, so restoring a version whose agent or orchestration has
 * since been deleted fails loudly with `WORKFLOW_VALIDATION_FAILED` rather than
 * writing a definition that would strand a task the moment it entered that state.
 */
const workflowVersionArchive = makeVersionArchive({
  store: workflowVersionStore,
  loadResource: async (args) => {
    return toResourceRef(await findWorkflowInstance(args));
  },
  mapVersion: mapWorkflowVersion,
  applyConfig: async (args): Promise<MappedWorkflow> => {
    // The archived definition is wire-shaped, so it goes back through the same
    // snake_case → camelCase boundary an inbound request does.
    return updateWorkflow({
      id: args.id,
      states: archivedCollection<WorkflowState>(args.config.states),
      transitions: archivedCollection<WorkflowTransition>(
        args.config.transitions
      ),
      // A version replaces the whole definition, so an absent schema means
      // "cleared", never "leave as is".
      payloadSchema: configObject(args.config.payload_schema),
      versionLabel: args.label,
      createdByUserId: args.createdByUserId,
    });
  },
});

// ── Read endpoints ───────────────────────────────────────────────────────

export const listWorkflowVersions = async (args: {
  workflowId: string;
  limit?: number;
  offset?: number;
}) => {
  log('listWorkflowVersions: workflowId=%s', args.workflowId);

  return workflowVersionArchive.listVersions({
    resourceId: args.workflowId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getWorkflowVersion = async (args: {
  workflowId: string;
  version: number;
}) => {
  log(
    'getWorkflowVersion: workflowId=%s version=%d',
    args.workflowId,
    args.version
  );

  return workflowVersionArchive.getVersion({
    resourceId: args.workflowId,
    version: args.version,
  });
};

export const restoreWorkflowVersion = async (args: {
  workflowId: string;
  version: number;
  label?: string | null;
  createdByUserId?: number | null;
}): Promise<MappedWorkflow> => {
  log(
    'restoreWorkflowVersion: workflowId=%s version=%d',
    args.workflowId,
    args.version
  );

  // Appends a new version rather than rewinding the counter, so a task pinned to
  // any version in between still resolves the machine it entered on. Tasks
  // already in flight are untouched: a restore is an ordinary definition edit,
  // and pinning is what keeps it from reaching them.
  return workflowVersionArchive.restoreVersion({
    resourceId: args.workflowId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });
};
