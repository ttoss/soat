/** The kinds of input a model reads, as a price row and a provider's declaration name them. */
export const INPUT_MODALITIES = [
  'text',
  'image',
  'file',
  'audio',
  'video',
] as const;

export type InputModality = (typeof INPUT_MODALITIES)[number];

const PART_MODALITIES: ReadonlyMap<string, InputModality> = new Map([
  ['text', 'text'],
  ['image', 'image'],
]);

// Messages are stored as the caller sent them, so every field reads as unknown.
const field = (value: unknown, key: string): unknown => {
  return Reflect.get(Object(value), key);
};

const MEDIA_TYPE_MODALITIES: ReadonlyArray<[string, InputModality]> = [
  ['image/', 'image'],
  ['audio/', 'audio'],
  ['video/', 'video'],
];

/** The modality of a `file` part of `mediaType`: `image`, `audio`, `video`, else `file`. */
export const mediaTypeModality = (mediaType: string): InputModality => {
  const match = MEDIA_TYPE_MODALITIES.find(([prefix]) => {
    return mediaType.startsWith(prefix);
  });
  return match ? match[1] : 'file';
};

// A `file` part is read by its media type: the provider prompt carries an
// image as a `file` part too.
const partModality = (part: unknown): InputModality | undefined => {
  const type = String(field(part, 'type'));
  if (type !== 'file') return PART_MODALITIES.get(type);
  return mediaTypeModality(String(field(part, 'mediaType')));
};

// A tool result read natively carries its parts under `output.value`.
const withToolResultParts = (part: unknown): unknown[] => {
  if (field(part, 'type') !== 'tool-result') return [part];
  const output = field(part, 'output');
  return field(output, 'type') === 'content'
    ? [field(output, 'value')].flat()
    : [];
};

const messageParts = (message: unknown): unknown[] => {
  const content = field(message, 'content');
  return typeof content === 'string'
    ? [{ type: 'text' }]
    : [content].flat().flatMap(withToolResultParts);
};

/** Every part `messages` carry, a native tool result's parts included. */
export const readInputParts = (
  messages: readonly unknown[] | null | undefined
): unknown[] => {
  return (messages ?? []).flatMap(messageParts);
};

/**
 * The sorted set of part types `messages` carry: a string content is `text`,
 * and a `file` part is `image`, `audio`, `video` or `file` by its media type.
 */
export const readInputModalities = (
  messages: readonly unknown[] | null | undefined
): InputModality[] => {
  const modalities = readInputParts(messages)
    .map(partModality)
    .filter((modality): modality is InputModality => {
      return modality !== undefined;
    });
  return [...new Set(modalities)].sort();
};
