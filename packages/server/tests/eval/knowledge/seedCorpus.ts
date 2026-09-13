import { db } from 'src/db';
import { createDocument } from 'src/lib/documents';
import { createMemory } from 'src/lib/memories';
import { writeMemoryEntry } from 'src/lib/memoryEntries';
import { createProject } from 'src/lib/projects';

import type { GoldenSet } from './goldenSet';
import { resolveDocumentContent } from './goldenSet';

/**
 * The tag every corpus fixture carries and every golden query filters on.
 *
 * It is not decoration. `searchKnowledge` turns memory search on only for a
 * query that names `memory_ids` or a tag filter, so without it the eval would
 * rank documents alone and every `entity` query would score zero for a reason
 * that has nothing to do with ranking.
 */
export const CORPUS_TAGS: Record<string, string> = {
  corpus: 'knowledge-golden',
};

/** The container every fixture that names no `memory` of its own is written to. */
const MEMORY_NAME = 'Knowledge golden corpus';

const MS_PER_DAY = 86400000;

export type SeededCorpus = {
  projectId: number;
  /** Document public id → golden key. Every chunk of a document shares one. */
  documentKeys: Map<string, string>;
  /** Memory entry public id → golden key. */
  memoryEntryKeys: Map<string, string>;
};

const resolveProjectId = async (args: {
  publicId: string;
}): Promise<number> => {
  const project = await db.Project.findOne({
    where: { publicId: args.publicId },
  });
  if (!project) {
    throw new Error(`seed: project '${args.publicId}' vanished after creation`);
  }
  return project.id as number;
};

const resolveMemoryId = async (args: { publicId: string }): Promise<number> => {
  const memory = await db.Memory.findOne({
    where: { publicId: args.publicId },
  });
  if (!memory) {
    throw new Error(`seed: memory '${args.publicId}' vanished after creation`);
  }
  return memory.id as number;
};

/**
 * Backdates an entry's `updated_at` by the fixture's `age_days`.
 *
 * Raw SQL because there is no model-level way in: `writeMemoryEntry` takes no
 * timestamp, and the column is managed, so Sequelize stamps the current time
 * over an explicit `updatedAt` on every write path — `silent`, `fields` and a
 * forced `changed()` on the instance included (all three were measured).
 *
 * The offset is applied against the run's own clock, so the corpus ages with it
 * and the ranking a fixture produces does not depend on the day it is run.
 */
const backdateEntry = async (args: {
  publicId: string;
  ageDays: number;
  seededAt: number;
}) => {
  await db.sequelize.query(
    'UPDATE memory_entries SET updated_at = :updatedAt WHERE public_id = :publicId',
    {
      replacements: {
        updatedAt: new Date(args.seededAt - args.ageDays * MS_PER_DAY),
        publicId: args.publicId,
      },
    }
  );
};

/**
 * Seeds the golden corpus into a project of its own, through the same lib
 * functions the product uses: `createDocument` chunks and embeds inline, and
 * ingestion never reaches the LLM boundary, so this exercises the real
 * ingestion path with no auth scaffolding in the way.
 */
export const seedGoldenCorpus = async (args: {
  golden: GoldenSet;
}): Promise<SeededCorpus> => {
  const project = await createProject({ name: 'Knowledge Retrieval Eval' });
  const projectId = await resolveProjectId({ publicId: project.id });

  const documentKeys = new Map<string, string>();

  for (const fixture of args.golden.corpus.documents) {
    const created = await createDocument({
      projectId,
      content: resolveDocumentContent({ document: fixture }),
      path: fixture.path,
      title: fixture.key,
      tags: CORPUS_TAGS,
      // Explicit rather than the `whole` default: fixed-size windows are what
      // production ingestion produces, and a multi-chunk document is the only
      // way the eval can observe one document occupying several result slots.
      chunkStrategy: 'size',
    });
    documentKeys.set(created.id, fixture.key);
  }

  // One clock read for the whole corpus: two fixtures with the same `age_days`
  // must land on the same timestamp however long seeding takes.
  const seededAt = Date.now();
  const memoryIds = new Map<string, number>();

  const resolveContainer = async (name: string): Promise<number> => {
    const existing = memoryIds.get(name);
    if (existing !== undefined) return existing;
    const created = await createMemory({ projectId, name, tags: CORPUS_TAGS });
    const id = await resolveMemoryId({ publicId: created.id });
    memoryIds.set(name, id);
    return id;
  };

  const memoryEntryKeys = new Map<string, string>();

  for (const fixture of args.golden.corpus.memories) {
    const written = await writeMemoryEntry({
      memoryId: await resolveContainer(fixture.memory ?? MEMORY_NAME),
      content: fixture.content,
      tags: fixture.tags ?? null,
    });
    // `writeMemoryEntry` deduplicates against the most similar existing entry
    // at 0.95. A fixture that merges into another is silently absent from the
    // corpus, and every query expecting it scores zero.
    if (written.action !== 'created') {
      throw new Error(
        `seed: memory fixture '${fixture.key}' was ${written.action} instead of created — it is too similar to an entry already seeded`
      );
    }
    if (fixture.age_days !== undefined) {
      await backdateEntry({
        publicId: written.entry.id,
        ageDays: fixture.age_days,
        seededAt,
      });
    }
    memoryEntryKeys.set(written.entry.id, fixture.key);
  }

  return { projectId, documentKeys, memoryEntryKeys };
};
