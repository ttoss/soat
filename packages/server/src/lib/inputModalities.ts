/** The part types a model input can carry, as a price row reads them. */
export type InputModality = 'text' | 'image' | 'file' | 'audio';

const PART_MODALITIES: Readonly<Record<string, InputModality>> = {
  text: 'text',
  image: 'image',
};

// A file part's modality is its media type's.
const fileModality = (part: object): InputModality => {
  const mediaType =
    'mediaType' in part && typeof part.mediaType === 'string'
      ? part.mediaType
      : '';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('image/')) return 'image';
  return 'file';
};

const partModality = (part: unknown): InputModality | null => {
  if (!part || typeof part !== 'object' || !('type' in part)) return null;
  if (part.type === 'file') return fileModality(part);
  return typeof part.type === 'string'
    ? (PART_MODALITIES[part.type] ?? null)
    : null;
};

/**
 * The sorted set of part types `messages` carry: a string content is `text`,
 * and a `file` part is `audio` or `image` by its media type.
 */
export const readInputModalities = (
  messages: readonly unknown[] | null | undefined
): InputModality[] => {
  const found = new Set<InputModality>();
  for (const message of messages ?? []) {
    const content =
      message && typeof message === 'object' && 'content' in message
        ? message.content
        : undefined;
    if (typeof content === 'string') {
      found.add('text');
      continue;
    }
    for (const part of Array.isArray(content) ? content : []) {
      const modality = partModality(part);
      if (modality) found.add(modality);
    }
  }
  return [...found].sort();
};
