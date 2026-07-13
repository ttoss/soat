/**
 * One-off data migration: rewrite every stored string-substitution token from
 * the legacy delimiters ({{secret:…}}, {param}, ${body.…}, formation `sub`
 * ${Name}, discussion {topic}/{steps.…}) into the unified `${namespace.path}`
 * grammar. Run once when upgrading past the string-template unification.
 *
 * The project uses schema-sync (no SQL migration framework) and every target
 * is a JSONB/text column, so this is an in-process backfill rather than a DDL
 * migration. It is idempotent (already-migrated rows are left unchanged), so
 * re-running is safe.
 *
 *   pnpm --filter @soat/server migrate:string-templates            # dry run
 *   pnpm --filter @soat/server migrate:string-templates -- --commit
 *
 * Dry run (default) prints every rewrite and per-table counts without writing.
 * Take a database snapshot before running with --commit.
 */
import { initialize } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { buildDatabaseConfig, type DB } from '../src/db';
import {
  migrateDiscussionString,
  migrateFormationTemplate,
  migrateToolExecute,
  migrateToolMcp,
} from './stringTemplateTransforms';

const log = createDebug('soat:migrate');
const COMMIT = process.argv.includes('--commit');

const isChanged = (before: unknown, after: unknown): boolean => {
  return JSON.stringify(before) !== JSON.stringify(after);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// Deep-walk a value, rewriting discussion tokens in every string leaf.
const migrateDiscussionNode = (node: unknown): unknown => {
  if (typeof node === 'string') return migrateDiscussionString(node);
  if (Array.isArray(node)) return node.map(migrateDiscussionNode);
  if (isRecord(node)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = migrateDiscussionNode(value);
    }
    return result;
  }
  return node;
};

const migrateTools = async (db: DB): Promise<number> => {
  let count = 0;
  for (const tool of await db.Tool.findAll()) {
    const execute = migrateToolExecute(tool.execute);
    const mcp = migrateToolMcp(tool.mcp);
    if (!isChanged(tool.execute, execute) && !isChanged(tool.mcp, mcp))
      continue;
    count += 1;
    log(
      'tool %s: %o/%o -> %o/%o',
      tool.publicId,
      tool.execute,
      tool.mcp,
      execute,
      mcp
    );
    if (COMMIT) {
      tool.execute = execute as object | null;
      tool.mcp = mcp as object | null;
      await tool.save();
    }
  }
  return count;
};

const migrateFormations = async (db: DB): Promise<number> => {
  let count = 0;
  for (const formation of await db.Formation.findAll()) {
    const template = migrateFormationTemplate(formation.template);
    if (!isChanged(formation.template, template)) continue;
    count += 1;
    log(
      'formation %s: %o -> %o',
      formation.publicId,
      formation.template,
      template
    );
    if (COMMIT) {
      formation.template = template as object | null;
      await formation.save();
    }
  }
  return count;
};

const migrateDiscussions = async (db: DB): Promise<number> => {
  let count = 0;
  for (const discussion of await db.Discussion.findAll()) {
    const synthesis = migrateDiscussionNode(discussion.synthesis);
    if (!isChanged(discussion.synthesis, synthesis)) continue;
    count += 1;
    log(
      'discussion %s: %o -> %o',
      discussion.publicId,
      discussion.synthesis,
      synthesis
    );
    if (COMMIT) {
      discussion.synthesis = synthesis as Record<string, unknown> | null;
      await discussion.save();
    }
  }
  return count;
};

const migrateParticipants = async (db: DB): Promise<number> => {
  let count = 0;
  for (const participant of await db.DiscussionParticipant.findAll()) {
    if (typeof participant.prompt !== 'string') continue;
    const prompt = migrateDiscussionString(participant.prompt);
    if (participant.prompt === prompt) continue;
    count += 1;
    log(
      'participant %s: %s -> %s',
      participant.publicId,
      participant.prompt,
      prompt
    );
    if (COMMIT) {
      participant.prompt = prompt;
      await participant.save();
    }
  }
  return count;
};

const run = async (): Promise<void> => {
  const db = await initialize(buildDatabaseConfig());
  const counts = {
    tools: await migrateTools(db),
    formations: await migrateFormations(db),
    discussions: await migrateDiscussions(db),
    participants: await migrateParticipants(db),
  };

  const mode = COMMIT ? 'COMMITTED' : 'DRY-RUN (pass --commit to apply)';
  // eslint-disable-next-line no-console
  console.log(
    `[migrate-string-templates] tools=${counts.tools} formations=${counts.formations} ` +
      `discussions=${counts.discussions} participants=${counts.participants} — ${mode}`
  );

  await db.sequelize.close();
};

run().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[migrate-string-templates] failed:', error);
  process.exit(1);
});
