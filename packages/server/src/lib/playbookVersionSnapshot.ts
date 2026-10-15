import { db } from '../db';
import {
  type ConfigSnapshot,
  makeVersionStore,
  projectConfigSnapshot,
} from './resourceVersions';

/**
 * How a playbook's definition is projected into the shared version archive
 * (`resourceVersions.ts`). The write side lives here so `playbooks.ts` reaches
 * it without importing `playbookVersions.ts`, which imports `playbooks.ts`
 * back.
 */

/**
 * Everything on a playbook response but its definition: the version number is
 * what a case cites to say which definition it is evaluated against, and a
 * rename changes none.
 */
const NON_CONFIG_PLAYBOOK_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'project_id',
  'name',
  'description',
  'version',
  'created_at',
  'updated_at',
]);

export const buildPlaybookConfigSnapshot = (
  playbook: Record<string, unknown>
): ConfigSnapshot => {
  return projectConfigSnapshot({
    resource: playbook,
    nonConfigFields: NON_CONFIG_PLAYBOOK_FIELDS,
  });
};

/** The write side of the playbook definition archive. */
export const playbookVersionStore = makeVersionStore({
  resourceLabel: 'Playbook',
  versionModel: () => {
    return db.PlaybookVersion;
  },
  resourceModel: () => {
    return db.Playbook;
  },
  foreignKey: 'playbookId',
});
