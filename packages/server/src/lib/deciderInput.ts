import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/**
 * A decision's `input`: a string, a list of user messages whose content mixes
 * `input_text` and base64 `input_image` parts (OpenAI's Decisions API shape),
 * or any other JSON value, shown to an agent as indented JSON.
 *
 * An array whose every entry carries `role` is read as messages and held to
 * that shape; anything else is a value.
 */

export type DecisionInputParts = {
  /** What the frame shows between its `<input>` tags. */
  text: string;
  /** Image data URLs, attached after the frame. */
  images: string[];
};

const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

const looksLikeMessages = (input: unknown): input is unknown[] => {
  return (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((entry) => {
      return isPlainObject(entry) && 'role' in entry;
    })
  );
};

const readPart = (args: {
  path: string;
  part: unknown;
  into: { texts: string[]; images: string[] };
}): void => {
  const { path, part, into } = args;
  if (!isPlainObject(part)) throw invalid(`${path} must be an object.`);
  if (part.type === 'input_text' && typeof part.text === 'string') {
    into.texts.push(part.text);
    return;
  }
  if (
    part.type === 'input_image' &&
    typeof part.image_url === 'string' &&
    IMAGE_DATA_URL.test(part.image_url)
  ) {
    into.images.push(part.image_url);
    return;
  }
  throw invalid(
    `${path} must be { type: input_text, text } or { type: input_image, image_url } with a base64 image data URL.`
  );
};

const readMessages = (messages: unknown[]): DecisionInputParts => {
  const into = { texts: [] as string[], images: [] as string[] };
  for (const [index, message] of messages.entries()) {
    const path = `input[${index}]`;
    if (!isPlainObject(message) || message.role !== 'user') {
      throw invalid(`${path}.role must be 'user'.`);
    }
    const { content } = message;
    if (typeof content === 'string') {
      into.texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) {
      throw invalid(`${path}.content must be a string or an array of parts.`);
    }
    for (const [partIndex, part] of content.entries()) {
      readPart({ path: `${path}.content[${partIndex}]`, part, into });
    }
  }
  return { text: into.texts.join('\n\n'), images: into.images };
};

/** Validates `input` and splits it into what an agent's frame shows. */
export const parseDecisionInput = (input: unknown): DecisionInputParts => {
  if (input === undefined) throw invalid('input is required.');
  if (typeof input === 'string') return { text: input, images: [] };
  if (looksLikeMessages(input)) return readMessages(input);
  return { text: JSON.stringify(input, null, 2), images: [] };
};
