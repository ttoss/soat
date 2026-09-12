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

const MEMORY_NAME = 'Knowledge golden corpus';

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

  const memory = await createMemory({
    projectId,
    name: MEMORY_NAME,
    tags: CORPUS_TAGS,
  });
  const memoryId = await resolveMemoryId({ publicId: memory.id });

  const memoryEntryKeys = new Map<string, string>();

  for (const fixture of args.golden.corpus.memories) {
    const written = await writeMemoryEntry({
      memoryId,
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
    memoryEntryKeys.set(written.entry.id, fixture.key);
  }

  return { projectId, documentKeys, memoryEntryKeys };
};
