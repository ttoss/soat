import 'dotenv/config';

import { initialize } from '@ttoss/postgresdb';

import { buildDatabaseConfig, type DB } from '../src/db';
import { renameSrnPrefix } from './renameSrnPrefixTransforms';

/**
 * One-shot data migration for the SRN prefix rename.
 *
 * Resource names in IAM policies lost the vendor token for the scheme name:
 *
 * ```txt
 * soat:<project>:<type>:<id>   ->   srn:<project>:<type>:<id>
 * ```
 *
 * Condition keys (`soat:ResourceTag/<key>`, `soat:ResourceType`) are **not**
 * part of this change — they are not resource names, and they keep their
 * prefix.
 *
 * ## Run this WITH the deploy, not after it
 *
 * This is a hard cutover, and unlike the tool-type rename it **fails closed
 * silently**. `extractProjectIdsFromPolicies` skips any resource that does not
 * start with `srn:` (`src/lib/iam.ts`), and `matchesPattern` will not match a
 * stored `soat:` pattern against a built `srn:` one. So between deploying the
 * new build and running this script, statements scoped by resource contribute
 * no project ids: reads return empty lists and writes return `403`, with
 * nothing in the logs naming the cause.
 *
 * Treat the deploy and this script as one step — drain, deploy, migrate, then
 * resume traffic:
 *
 * ```bash
 * pnpm --filter @soat/server exec tsx scripts/renameSrnPrefix.ts --dry-run
 * pnpm --filter @soat/server exec tsx scripts/renameSrnPrefix.ts
 * ```
 *
 * It is idempotent: a second run finds nothing to change and reports 0 rows.
 *
 * ## What it cannot migrate
 *
 * `audit_entries.resource_srn` is append-only — the model-layer hooks reject
 * every update — so historical rows keep their `soat:` SRN permanently. That is
 * handled on the read side instead: the `resource_srn` prefix filter in
 * `src/lib/auditLog.ts` matches both spellings, so an audit search still finds
 * pre-rename history. Nothing rewrites the stored value; the log reads exactly
 * as it was written.
 */

const log = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(message);
};

/**
 * Apply the rewrite to a JSONB value, proving at runtime that it came back an
 * object so the result can be written to an object-typed column without a cast.
 * The transform preserves shape, so a throw here is a bug in this script.
 *
 * Returns `null` when nothing changed, so a re-run issues no UPDATE and the
 * reported counts stay honest.
 */
const rewriteJson = (value: object): object | null => {
  const result = renameSrnPrefix(value);

  if (result === null || typeof result !== 'object') {
    throw new Error(
      `Transform did not preserve object shape: got ${typeof result}.`
    );
  }

  if (JSON.stringify(value) === JSON.stringify(result)) return null;

  return result;
};

/**
 * Read every row of one table, rewrite the rows whose JSONB actually changes,
 * and report how many.
 */
const migrateRows = async <TRow, TValue>(args: {
  label: string;
  dryRun: boolean;
  load: () => Promise<TRow[]>;
  rewrite: (row: TRow) => TValue | null;
  write: (row: TRow, value: TValue) => Promise<unknown>;
}): Promise<number> => {
  let changed = 0;

  for (const row of await args.load()) {
    const value = args.rewrite(row);
    if (value === null) continue;

    changed += 1;
    if (!args.dryRun) await args.write(row, value);
  }

  log(`${args.dryRun ? '[dry-run] ' : ''}${args.label}: ${changed} row(s)`);
  return changed;
};

type Step = { db: DB; dryRun: boolean };

/** Policy documents: the standalone ones and the per-agent boundary policies. */
const migratePolicies = async (args: Step): Promise<number[]> => {
  const { db, dryRun } = args;

  return [
    await migrateRows({
      label: 'Policy.document',
      dryRun,
      load: () => {
        return db.Policy.findAll();
      },
      rewrite: (row) => {
        return rewriteJson(row.document);
      },
      write: (row, document) => {
        return db.Policy.update({ document }, { where: { id: row.id } });
      },
    }),

    await migrateRows({
      label: 'Agent.boundaryPolicy',
      dryRun,
      load: () => {
        return db.Agent.findAll();
      },
      rewrite: (row) => {
        return row.boundaryPolicy ? rewriteJson(row.boundaryPolicy) : null;
      },
      write: (row, boundaryPolicy) => {
        return db.Agent.update({ boundaryPolicy }, { where: { id: row.id } });
      },
    }),

    // Snapshots are replayed through the ordinary update path on restore, so an
    // un-migrated one would restore a policy that silently matches nothing.
    await migrateRows({
      label: 'AgentVersion.config',
      dryRun,
      load: () => {
        return db.AgentVersion.findAll();
      },
      rewrite: (row) => {
        return rewriteJson(row.config);
      },
      write: (row, config) => {
        return db.AgentVersion.update({ config }, { where: { id: row.id } });
      },
    }),
  ];
};

/** Formation templates and their last-applied resource properties. */
const migrateFormations = async (args: Step): Promise<number[]> => {
  const { db, dryRun } = args;

  return [
    await migrateRows({
      label: 'Formation.template',
      dryRun,
      load: () => {
        return db.Formation.findAll();
      },
      rewrite: (row) => {
        return row.template ? rewriteJson(row.template) : null;
      },
      write: (row, template) => {
        return db.Formation.update({ template }, { where: { id: row.id } });
      },
    }),

    await migrateRows({
      label: 'FormationResource.lastAppliedProperties',
      dryRun,
      load: () => {
        return db.FormationResource.findAll();
      },
      rewrite: (row) => {
        return row.lastAppliedProperties
          ? rewriteJson(row.lastAppliedProperties)
          : null;
      },
      write: (row, lastAppliedProperties) => {
        return db.FormationResource.update(
          { lastAppliedProperties },
          { where: { id: row.id } }
        );
      },
    }),
  ];
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');

  const db = await initialize(buildDatabaseConfig());

  log(
    dryRun
      ? '--- Rename SRN prefix (DRY RUN — nothing is written) ---'
      : '--- Rename SRN prefix ---'
  );

  const counts = [
    ...(await migratePolicies({ db, dryRun })),
    ...(await migrateFormations({ db, dryRun })),
  ];

  const total = counts.reduce((sum, count) => {
    return sum + count;
  }, 0);
  log(`${dryRun ? '[dry-run] ' : ''}Total: ${total} row(s)`);
  log(
    'audit_entries.resource_srn is append-only and keeps its soat: SRNs; the ' +
      'resource_srn prefix filter matches both spellings.'
  );

  await db.sequelize.close();
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
