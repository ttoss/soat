import type { Migration } from '@ttoss/postgresdb';

import { memoryTagsToJsonb } from './2026-09-11-memoryTagsToJsonb';
import { memoriesRenameAndProvenance } from './2026-09-16-memoriesRenameAndProvenance';
import { memoryAssertionsAndSharedContent } from './2026-09-16-memoryAssertionsAndSharedContent';
import { memoryRulesFromAgentExtraction } from './2026-09-16-memoryRulesFromAgentExtraction';
import { memoryAssertionsDeclared } from './2026-09-17-memoryAssertionsDeclared';

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
];
