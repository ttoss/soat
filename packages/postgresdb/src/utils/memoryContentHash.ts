import { createHash } from 'node:crypto';

/**
 * Punctuation is dropped unless it sits between two digits, so `1.5` and `15`
 * stay distinct while a trailing period or a comma before a clause does not.
 */
const PUNCTUATION = /(?<!\d)\p{P}+|\p{P}+(?!\d)/gu;

/**
 * The form two texts must share to be the same content: NFKC, lowercased,
 * punctuation dropped, whitespace collapsed. The embedder scores case and
 * punctuation as content, so without this a lowercased restatement of a fact
 * can land below `supersede_threshold` and be stored twice.
 */
export const normalizeMemoryContent = (args: { content: string }): string => {
  return args.content
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .trim()
    .replace(/\s+/g, ' ');
};

/**
 * The dedup key of a store's text. Changing `normalizeMemoryContent` means a
 * migration that rehashes `memory_contents` and merges the rows that collide.
 */
export const hashMemoryContent = (args: { content: string }): string => {
  return createHash('sha256')
    .update(normalizeMemoryContent(args))
    .digest('hex');
};
