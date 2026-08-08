import { db } from '../db';
import type { MappedOrchestration } from './orchestrations';
import {
  type ConfigSnapshot,
  makeVersionStore,
  projectConfigSnapshot,
} from './resourceVersions';

/**
 * How an orchestration's configuration is projected into the shared version
 * archive (`resourceVersions.ts`). Everything generic — the projection
 * mechanics, the change detection, the equality check — lives there.
 *
 * This module holds the archive's **write side** so that `orchestrations.ts` can
 * reach it without importing `orchestrationVersions.ts`, which imports
 * `orchestrations.ts` back for `updateOrchestration`.
 */

/**
 * An orchestration's archived configuration, in the wire (snake_case) shape the
 * orchestrations OpenAPI spec documents.
 */
export type OrchestrationConfigSnapshot = ConfigSnapshot;

/**
 * The keys of an orchestration response that are **not** configuration: its
 * identity, its version bookkeeping, its timestamps — and its name and
 * description.
 *
 * Name and description are metadata, as they are for a guardrail: bumping the
 * version when one of them changes would make two version numbers denote the
 * same topology, and the version number is exactly what a run cites to say which
 * topology it executed. What remains — `nodes`, `edges`, `state_schema`,
 * `input_schema` — is the graph the engine executes and nothing else.
 *
 * Stated as an exclusion rather than an allowlist on purpose; see
 * `projectConfigSnapshot` for why. `orchestrationVersions.test.ts` pins the exact
 * key set the projection produces, so adding an orchestration field forces a
 * deliberate choice here.
 */
const NON_CONFIG_ORCHESTRATION_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'project_id',
  'name',
  'description',
  'version',
  'created_at',
  'updated_at',
]);

/**
 * Projects an orchestration response down to its graph.
 *
 * The graph is copied as a **value**. `nodes` and `edges` carry author-authored
 * JSON Logic (`expression`, `input_mapping`, `state_mapping`, `exit_condition`)
 * whose `var` paths must round-trip byte-for-byte, and the two schemas are
 * caller-authored JSON Schema — nothing here descends into any of them or
 * rewrites a key (`.claude/rules/case-convention.md`).
 */
export const buildOrchestrationConfigSnapshot = (
  orchestration: MappedOrchestration
): OrchestrationConfigSnapshot => {
  return projectConfigSnapshot({
    resource: orchestration,
    nonConfigFields: NON_CONFIG_ORCHESTRATION_FIELDS,
  });
};

/** The write side of the orchestration graph archive. */
export const orchestrationVersionStore = makeVersionStore({
  resourceLabel: 'Orchestration',
  versionModel: () => {
    return db.OrchestrationVersion;
  },
  foreignKey: 'orchestrationId',
});
