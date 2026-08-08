import { db } from '../db';
import {
  type ConfigSnapshot,
  makeVersionStore,
  projectConfigSnapshot,
} from './resourceVersions';
import type { MappedWorkflow } from './workflows';

/**
 * How a workflow's configuration is projected into the shared version archive
 * (`resourceVersions.ts`). Everything generic — the projection mechanics, the
 * change detection, the equality check — lives there.
 *
 * This module holds the archive's **write side** so that `workflows.ts` can reach
 * it without importing `workflowVersions.ts`, which imports `workflows.ts` back
 * for `updateWorkflow`.
 */

/**
 * A workflow's archived configuration, in the wire (snake_case) shape the
 * workflows OpenAPI spec documents.
 */
export type WorkflowConfigSnapshot = ConfigSnapshot;

/**
 * The keys of a workflow response that are **not** configuration: its identity,
 * its version bookkeeping, its timestamps — and its name and description.
 *
 * Name and description are metadata, as they are for an orchestration: bumping
 * the version when one of them changes would make two version numbers denote the
 * same state machine, and the version number is exactly what a task cites to say
 * which machine it is living in. What remains — `states`, `transitions`,
 * `payload_schema` — is the machine the engine runs and nothing else.
 *
 * Stated as an exclusion rather than an allowlist on purpose; see
 * `projectConfigSnapshot` for why. `workflowVersions.test.ts` pins the exact key
 * set the projection produces, so adding a workflow field forces a deliberate
 * choice here.
 */
const NON_CONFIG_WORKFLOW_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'project_id',
  'name',
  'description',
  'version',
  'created_at',
  'updated_at',
]);

/**
 * Projects a workflow response down to its state machine.
 *
 * The machine is copied as a **value**. `states` and `transitions` carry
 * author-authored JSON Logic (`guard`, `when`) and author-owned bags
 * (`input_mapping`, `payload_writes`) whose keys must round-trip byte-for-byte,
 * and `payload_schema` is caller-authored JSON Schema — nothing here descends
 * into any of them or rewrites a key (`.claude/rules/case-convention.md`).
 */
export const buildWorkflowConfigSnapshot = (
  workflow: MappedWorkflow
): WorkflowConfigSnapshot => {
  return projectConfigSnapshot({
    resource: workflow,
    nonConfigFields: NON_CONFIG_WORKFLOW_FIELDS,
  });
};

/** The write side of the workflow state-machine archive. */
export const workflowVersionStore = makeVersionStore({
  resourceLabel: 'Workflow',
  versionModel: () => {
    return db.WorkflowVersion;
  },
  foreignKey: 'workflowId',
});
