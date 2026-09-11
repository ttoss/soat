import { db } from 'src/db';
import { mergeTags } from 'src/lib/tags';

// Only ever called by the memory-entry tag routes, which resolve the entry and
// its memory's project through `resolveEntryForAction` first.

export const getMemoryEntryTags = async (args: { id: string }) => {
  const entry = await db.MemoryEntry.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;
  return entry.tags ?? {};
};

export const updateMemoryEntryTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const entry = await db.MemoryEntry.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;

  const newTags = mergeTags({
    current: entry.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  await entry.update({ tags: newTags });

  // The tag routes' contract is the tag map itself, not the entry.
  return newTags;
};
