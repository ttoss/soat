import { db } from '../db';
import {
  type ConfigSnapshot,
  makeVersionStore,
  projectConfigSnapshot,
} from './resourceVersions';

/**
 * How a decider's question set is projected into the shared version archive
 * (`resourceVersions.ts`). The write side lives here so `deciders.ts` reaches
 * it without importing `deciderVersions.ts`, which imports `deciders.ts` back.
 */

/**
 * Everything on a decider response but its questions. The agent is metadata
 * like the name: a version number is what a decision cites to say which
 * criteria it was answered under, and repointing the agent changes none.
 */
const NON_CONFIG_DECIDER_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'project_id',
  'name',
  'description',
  'agent_id',
  'version',
  'created_at',
  'updated_at',
]);

export const buildDeciderConfigSnapshot = (
  decider: Record<string, unknown>
): ConfigSnapshot => {
  return projectConfigSnapshot({
    resource: decider,
    nonConfigFields: NON_CONFIG_DECIDER_FIELDS,
  });
};

/** The write side of the decider question-set archive. */
export const deciderVersionStore = makeVersionStore({
  resourceLabel: 'Decider',
  versionModel: () => {
    return db.DeciderVersion;
  },
  resourceModel: () => {
    return db.Decider;
  },
  foreignKey: 'deciderId',
});
