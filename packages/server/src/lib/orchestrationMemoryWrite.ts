import type { MemoryEntrySource } from '@soat/postgresdb';
import { MEMORY_ENTRY_SOURCES } from '@soat/postgresdb';

export type MemoryWriteInputs = {
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sourceType: MemoryEntrySource;
};

const parseTags = (rawTags: unknown): string[] | undefined => {
  if (Array.isArray(rawTags)) {
    return rawTags.filter((t): t is string => {
      return typeof t === 'string';
    });
  }
  // A `{ role: 'x' }`-style mapping is flattened into `key:value` tag strings.
  if (rawTags && typeof rawTags === 'object') {
    return Object.entries(rawTags as Record<string, unknown>).map(([k, v]) => {
      return `${k}:${String(v)}`;
    });
  }
  return undefined;
};

const parseMetadata = (
  rawMetadata: unknown
): Record<string, unknown> | undefined => {
  return rawMetadata &&
    typeof rawMetadata === 'object' &&
    !Array.isArray(rawMetadata)
    ? (rawMetadata as Record<string, unknown>)
    : undefined;
};

const parseSourceType = (rawSourceType: unknown): MemoryEntrySource => {
  return MEMORY_ENTRY_SOURCES.includes(rawSourceType as MemoryEntrySource)
    ? (rawSourceType as MemoryEntrySource)
    : 'orchestration';
};

/**
 * Normalizes a `memory_write` node's mapped inputs into the shape
 * `writeMemoryEntry` expects: `content` is coerced to a string, `tags` accepts
 * either a string array or a `{ key: value }` mapping (flattened to
 * `key:value`), `metadata` must be a plain object, and `sourceType` defaults to
 * `orchestration` when the mapping does not supply a valid value.
 */
export const parseMemoryWriteInputs = (
  inputs: Record<string, unknown>
): MemoryWriteInputs => {
  const content =
    typeof inputs['content'] === 'string'
      ? inputs['content']
      : JSON.stringify(inputs['content'] ?? '');

  return {
    content,
    tags: parseTags(inputs['tags']),
    metadata: parseMetadata(inputs['metadata']),
    sourceType: parseSourceType(inputs['sourceType']),
  };
};
