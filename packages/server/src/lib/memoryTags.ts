import { db } from 'src/db';
import { mergeTags } from 'src/lib/tags';

// Only ever called by the memory tag routes, which resolve the entry and
// its memory store's project through `resolveEntryForAction` first.

export const getMemoryTags = async (args: { id: string }) => {
  const entry = (await db.Memory.findOne({
    where: { publicId: args.id },
  }))!;
  return entry.tags ?? {};
};

export const updateMemoryTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const entry = (await db.Memory.findOne({
    where: { publicId: args.id },
  }))!;

  const newTags = mergeTags({
    current: entry.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  await entry.update({ tags: newTags });

  // The tag routes' contract is the tag map itself, not the entry.
  return newTags;
};
