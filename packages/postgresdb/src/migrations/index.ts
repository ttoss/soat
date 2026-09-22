import type { Migration } from '@ttoss/postgresdb';

import { memoryTagsToJsonb } from './2026-09-11-memoryTagsToJsonb';
import { memoriesRenameAndProvenance } from './2026-09-16-memoriesRenameAndProvenance';
import { memoryAssertionsAndSharedContent } from './2026-09-16-memoryAssertionsAndSharedContent';
import { memoryRulesFromAgentExtraction } from './2026-09-16-memoryRulesFromAgentExtraction';
import { memoryAssertionsDeclared } from './2026-09-17-memoryAssertionsDeclared';
import { activityEntryGenerationId } from './2026-09-18-activityEntryGenerationId';
import { orchestrationRunIdempotencyKey } from './2026-09-18-orchestrationRunIdempotencyKey';
import { orchestrationNodeExecutionDispatches } from './2026-09-20-orchestrationNodeExecutionDispatches';
import { triggerToolContext } from './2026-09-20-triggerToolContext';
import { documentMetadataJsonb } from './2026-09-21-documentMetadataJsonb';
import { documentVersions } from './2026-09-21-documentVersions';
import { durableEventFirings } from './2026-09-21-durableEventFirings';
import { memoryVersion } from './2026-09-21-memoryVersion';
import { tagBagGinIndexes } from './2026-09-22-tagBagGinIndexes';

/**
 * The schema changes `sync` cannot make, in the order they run. Order is a
 * contract — a later migration may assume an earlier one has happened, and
 * nothing may assume the reverse. Here the rename meets tables whose `tags`
 * column the first migration has already converted.
 *
 * A name is the migration's identity in the ledger and is permanent: renaming
 * or removing one that has run anywhere leaves the ledger holding a name
 * nothing declares, and the runner refuses to start.
 *
 * Each name and file carries the change's date as a `YYYY-MM-DD-` prefix, so
 * `ls` and `migrate status` both read in the order they run. The prefix is a
 * label, not the ordering itself — this array is what the runner applies, and
 * `tests/unit/tests/migrations.test.ts` fails if the two disagree.
 *
 * Every entry declares `isApplied`, so adopting the ledger needs no operator
 * step — a database that already carries a change records it rather than
 * replaying it. `tests/unit/tests/migrations.test.ts` enforces that.
 */
export const MIGRATIONS: Migration[] = [
  memoryTagsToJsonb,
  memoriesRenameAndProvenance,
  memoryAssertionsAndSharedContent,
  memoryRulesFromAgentExtraction,
  memoryAssertionsDeclared,
  activityEntryGenerationId,
  orchestrationRunIdempotencyKey,
  orchestrationNodeExecutionDispatches,
  triggerToolContext,
  durableEventFirings,
  documentMetadataJsonb,
  documentVersions,
  memoryVersion,
  tagBagGinIndexes,
];
