/** The part types a model input can carry, as a price row reads them. */
export type InputModality = 'text' | 'image' | 'file' | 'audio';

const PART_MODALITIES: ReadonlyMap<string, InputModality> = new Map([
  ['text', 'text'],
  ['image', 'image'],
]);

// Messages are stored as the caller sent them, so every field reads as unknown.
const field = (value: unknown, key: string): unknown => {
  return Reflect.get(Object(value), key);
};

// A `file` part is `audio` by its media type; an image arrives as an `image` part.
const partModality = (part: unknown): InputModality | undefined => {
  const type = String(field(part, 'type'));
  if (type !== 'file') return PART_MODALITIES.get(type);
  return String(field(part, 'mediaType')).startsWith('audio/')
    ? 'audio'
    : 'file';
};

const messageParts = (message: unknown): unknown[] => {
  const content = field(message, 'content');
  return typeof content === 'string' ? [{ type: 'text' }] : [content].flat();
};

/**
 * The sorted set of part types `messages` carry: a string content is `text`,
 * and a `file` part is `audio` or `file` by its media type.
 */
export const readInputModalities = (
  messages: readonly unknown[] | null | undefined
): InputModality[] => {
  const modalities = (messages ?? [])
    .flatMap(messageParts)
    .map(partModality)
    .filter((modality): modality is InputModality => {
      return modality !== undefined;
    });
  return [...new Set(modalities)].sort();
};
