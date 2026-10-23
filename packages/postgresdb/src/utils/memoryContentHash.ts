import { createHash } from 'node:crypto';

const sha256 = (text: string) => {
  return createHash('sha256').update(text).digest('hex');
};

/**
 * Punctuation is dropped unless it sits between two digits, so `1.5` and `15`
 * stay distinct while a trailing period or a comma before a clause does not.
 */
const PUNCTUATION = /(?<!\d)\p{P}+|\p{P}+(?!\d)/gu;

/**
 * The key of one stored spelling, `content_hash`, unique per store: trimmed and
 * whitespace-collapsed only, so every distinct spelling keeps its own row.
 */
export const hashMemoryContent = (args: { content: string }): string => {
  return sha256(args.content.trim().replace(/\s+/g, ' '));
};

/**
 * The key spellings of one text share, `normalized_hash`: NFKC, lowercased,
 * punctuation dropped. The embedder scores case and punctuation as content, so
 * a lowercased restatement re-embedded can land below `supersede_threshold`.
 */
export const hashNormalizedMemoryContent = (args: {
  content: string;
}): string => {
  return sha256(
    args.content
      .normalize('NFKC')
      .toLowerCase()
      .replace(PUNCTUATION, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
};
