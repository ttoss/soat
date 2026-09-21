import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { emitResourceEvent } from 'src/lib/eventBus';
import type { MemoryAssertionSource } from 'src/lib/memoryAssertions';
import { recordMemoryAssertion } from 'src/lib/memoryAssertions';
import { mapMemory, memories } from 'src/lib/memoryMapper';
import { validMemoryWhere } from 'src/lib/memoryValidity';
import {
  assertWritePrecondition,
  versionConflict,
} from 'src/lib/writePrecondition';

const log = createDebug('soat:memories');

/**
 * Retracting a fact: the memory stops holding, and nothing takes its place.
 *
 * It is an invalidation with no successor, which is why it needs no marker of
 * its own. Dedup, listing and knowledge search already read only currently
 * valid memories, so a `deleted_at` beside `invalidated_at` would make every
 * one of them carry a second exclusion — and the retracted fact a
 * nearest-neighbour search still returns is exactly what a missed one looks
 * like. What a retraction adds is the ledger row that says who withdrew it,
 * and the null `superseded_by_memory_id` that tells it apart from a supersede.
 *
 * `DELETE` stays what it is: the memory and its history go. Retraction keeps
 * both and only stops the fact being answered with.
 */
export const retractMemory = async (args: {
  id: string;
  /** `null`/absent states no precondition; see {@link readWritePrecondition}. */
  expectedVersion?: number | null;
  assertion: MemoryAssertionSource;
}) => {
  log('retractMemory: id=%s', args.id);

  const entry = await db.Memory.findOne({ where: { publicId: args.id } });
  /* istanbul ignore next -- the route reads the memory through `getMemory` and
     answers `404` before reaching here. */
  if (!entry) return null;

  assertWritePrecondition({
    expectedVersion: args.expectedVersion,
    currentVersion: entry.version,
    resourceLabel: 'Memory',
    resourceId: entry.publicId,
  });

  // Validity is part of the claim, not a check before it: a supersede retires
  // its target without touching the counter, so a `where` naming the version
  // alone would let a retraction land on a memory that a concurrent write had
  // already replaced — leaving a row both superseded and retracted.
  const currentVersion = entry.version;
  const [claimed] = await db.Memory.update(
    { invalidatedAt: new Date(), version: currentVersion + 1 },
    {
      where: {
        id: entry.id,
        version: currentVersion,
        ...validMemoryWhere(),
      },
    }
  );

  if (claimed === 0) {
    const live = await db.Memory.findOne({ where: { id: entry.id } });
    if (live?.invalidatedAt) {
      throw new DomainError(
        'MEMORY_ALREADY_INVALIDATED',
        `Memory '${entry.publicId}' no longer holds.`,
        { memory_id: entry.publicId }
      );
    }
    throw versionConflict({
      currentVersion: live?.version ?? currentVersion,
      expectedVersion: args.expectedVersion ?? null,
      resourceLabel: 'Memory',
      resourceId: entry.publicId,
    });
  }

  await recordMemoryAssertion({
    memoryStoreId: entry.memoryStoreId,
    contentId: entry.contentId,
    memoryId: entry.id as number,
    outcome: 'retracted',
    // Nothing was compared: a retraction is a statement about one memory.
    similarity: null,
    source: args.assertion,
  });

  const mapped = mapMemory(await memories.reload(entry));

  const memoryStore = await db.MemoryStore.findByPk(entry.memoryStoreId, {
    attributes: ['projectId'],
  });

  emitResourceEvent({
    type: 'memories.retracted',
    projectId: memoryStore!.projectId,
    resourceType: 'memory',
    resourceId: entry.publicId,
    data: mapped,
  });

  return mapped;
};
