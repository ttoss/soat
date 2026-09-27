import { TAG_BAG_COMMANDS } from '../../generated/tagBagCommands.js';
import type { Wrapper } from '../types.js';

const TAGS_FLAG = 'tags';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readBag = (
  raw: string | undefined
): { bag: Record<string, unknown> } | { error: string } => {
  if (raw === undefined) {
    return { error: `Missing required flag --${TAGS_FLAG} <object>.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    return {
      error: `--${TAGS_FLAG} must be a JSON object, e.g. --${TAGS_FLAG} '{"team":"finance"}'.`,
    };
  }
  return { bag: parsed };
};

/**
 * A tag route's body is the bag itself, so there is no property for the
 * manifest to derive a flag from. `--tags` carries the whole body; the server
 * validates the values.
 */
export const tagBagsWrapper: Wrapper = {
  id: 'tag-bags',
  commands: [...TAG_BAG_COMMANDS],
  helpFlags: [
    {
      name: TAGS_FLAG,
      description:
        'The tag bag, a flat JSON object of string values. replace-* sets exactly these tags; merge-* adds them over the existing ones.',
      required: true,
      type: 'object',
    },
  ],
  apply: ({ context }) => {
    const { [TAGS_FLAG]: raw, ...single } = context.parsedFlags.single;
    const flags = { ...context.parsedFlags, single };
    const result = readBag(raw);
    if ('error' in result) {
      return { flags, forcedBody: {}, errors: [result.error] };
    }
    return { flags, forcedBody: {}, rootBody: result.bag };
  },
};
