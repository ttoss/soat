import 'dotenv/config';

import { initialize } from '@ttoss/postgresdb';

import { buildDatabaseConfig, type DB } from '../src/db';
import {
  type Json,
  renameBoth,
  renameNamespace,
  renameToolType,
} from './renameSoatTokensTransforms';

/**
 * One-shot data migration for the vendor-neutral rename.
 *
 * Two author-facing tokens lost the `soat` brand in the same change, and both
 * are persisted as data rather than schema:
 *
 * | Token | Before | After |
 * | --- | --- | --- |
 * | Guardrail context namespace | `soat.usage.cost_usd_24h` | `runtime.usage.cost_usd_24h` |
 * | Tool type | `type: 'soat'` | `type: 'builtin'` |
 *
 * The validators cut over hard — a document referencing `soat.*` is now rejected
 * as out-of-namespace, and `type: 'soat'` as an unsupported tool type — so rows
 * written before the upgrade must be rewritten or they fail on their next write.
 * `guardrail_versions` and `agent_versions` are rewritten too: restoring a
 * version replays it through the ordinary update path, so an un-migrated
 * snapshot would `400` on restore.
 *
 * Run it once, against a drained server, after deploying the new build:
 *
 * ```bash
 * pnpm --filter @soat/server exec tsx scripts/renameSoatTokens.ts --dry-run
 * pnpm --filter @soat/server exec tsx scripts/renameSoatTokens.ts
 * ```
 *
 * It is idempotent: a second run finds nothing to change and reports 0 rows.
 *
 * Deliberately **not** rewritten:
 *
 * - `guardrail_evaluations.context_snapshot` — an immutable record of what a
 *   past evaluation actually read, keyed by the path the document used *then*.
 *   Rewriting it would falsify the audit trail.
 * - IAM SRNs (`soat:<project>:<type>:<id>`) and policy condition keys
 *   (`soat:ResourceTag/…`) — out of scope for this rename; they stay branded.
 * - The `soat` usage/pricing vendor slug — that is genuinely the vendor.
 */

const log = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(message);
};

/**
 * Apply a transform to a JSONB value, proving at runtime that it came back an
 * object so the result can be written to an object-typed column without a cast.
 * Both transforms preserve shape, so a throw here is a bug in this script.
 */
const rewriteJson = (args: {
  value: object;
  transform: (value: Json) => Json;
}): object | null => {
  const result = args.transform(args.value);

  if (result === null || typeof result !== 'object') {
    throw new Error(
      `Transform did not preserve object shape: got ${typeof result}.`
    );
  }

  // Nothing changed — signal "no write needed" rather than issuing a no-op
  // UPDATE, which keeps the run idempotent and the reported counts honest.
  if (JSON.stringify(args.value) === JSON.stringify(result)) return null;

  return result;
};

/** The `toolBindings` variant: the column holds an array, not a bare object. */
const rewriteJsonArray = (args: {
  value: object[];
  transform: (value: Json) => Json;
}): object[] | null => {
  const result = args.transform(args.value);

  if (!Array.isArray(result)) {
    throw new Error('Transform did not preserve array shape.');
  }

  if (JSON.stringify(args.value) === JSON.stringify(result)) return null;

  return result;
};

/**
 * Read every row of one table, rewrite the rows whose JSONB actually changes,
 * and report how many. `rewrite` returns `null` for an untouched row, which is
 * what keeps a re-run idempotent and the printed counts honest.
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

/** `tools.type` — a scalar column, so a single conditional UPDATE covers it. */
const migrateToolType = async (args: {
  db: DB;
  dryRun: boolean;
}): Promise<number> => {
  const pending = await args.db.Tool.count({ where: { type: 'soat' } });

  if (!args.dryRun && pending > 0) {
    await args.db.Tool.update({ type: 'builtin' }, { where: { type: 'soat' } });
  }

  log(`${args.dryRun ? '[dry-run] ' : ''}Tool.type: ${pending} row(s)`);
  return pending;
};

type Step = { db: DB; dryRun: boolean };

/** The guardrail context namespace: `soat.<catalog-root>` → `runtime.…`. */
const migrateGuardrailNamespace = async (args: Step): Promise<number[]> => {
  const { db, dryRun } = args;

  return [
    await migrateRows({
      label: 'Guardrail.document',
      dryRun,
      load: () => {
        return db.Guardrail.findAll();
      },
      rewrite: (row) => {
        return rewriteJson({ value: row.document, transform: renameNamespace });
      },
      write: (row, document) => {
        return db.Guardrail.update({ document }, { where: { id: row.id } });
      },
    }),

    await migrateRows({
      label: 'GuardrailVersion.config',
      dryRun,
      load: () => {
        return db.GuardrailVersion.findAll();
      },
      rewrite: (row) => {
        return rewriteJson({ value: row.config, transform: renameNamespace });
      },
      write: (row, config) => {
        return db.GuardrailVersion.update(
          { config },
          { where: { id: row.id } }
        );
      },
    }),
  ];
};

/** The tool type discriminator: `type: 'soat'` → `'builtin'`. */
const migrateToolTypeColumns = async (args: Step): Promise<number[]> => {
  const { db, dryRun } = args;

  return [
    await migrateToolType({ db, dryRun }),

    await migrateRows({
      label: 'Tool.pipeline',
      dryRun,
      load: () => {
        return db.Tool.findAll();
      },
      rewrite: (row) => {
        if (!row.pipeline) return null;
        return rewriteJson({ value: row.pipeline, transform: renameToolType });
      },
      write: (row, pipeline) => {
        return db.Tool.update({ pipeline }, { where: { id: row.id } });
      },
    }),

    await migrateRows({
      label: 'Agent.toolBindings',
      dryRun,
      load: () => {
        return db.Agent.findAll();
      },
      rewrite: (row) => {
        if (!row.toolBindings) return null;
        return rewriteJsonArray({
          value: row.toolBindings,
          transform: renameToolType,
        });
      },
      write: (row, toolBindings) => {
        return db.Agent.update({ toolBindings }, { where: { id: row.id } });
      },
    }),

    await migrateRows({
      label: 'AgentVersion.config',
      dryRun,
      load: () => {
        return db.AgentVersion.findAll();
      },
      rewrite: (row) => {
        return rewriteJson({ value: row.config, transform: renameToolType });
      },
      write: (row, config) => {
        return db.AgentVersion.update({ config }, { where: { id: row.id } });
      },
    }),
  ];
};

/** Formation templates carry both tokens — a guardrail document and a tool type. */
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
        if (!row.template) return null;
        return rewriteJson({ value: row.template, transform: renameBoth });
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
        if (!row.lastAppliedProperties) return null;
        return rewriteJson({
          value: row.lastAppliedProperties,
          transform: renameBoth,
        });
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
      ? '--- Rename soat tokens (DRY RUN — nothing is written) ---'
      : '--- Rename soat tokens ---'
  );

  const counts = [
    ...(await migrateGuardrailNamespace({ db, dryRun })),
    ...(await migrateToolTypeColumns({ db, dryRun })),
    ...(await migrateFormations({ db, dryRun })),
  ];

  const total = counts.reduce((sum, count) => {
    return sum + count;
  }, 0);
  log(`${dryRun ? '[dry-run] ' : ''}Total: ${total} row(s)`);

  await db.sequelize.close();
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
