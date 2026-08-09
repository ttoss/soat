import createDebug from 'debug';

import { DomainError } from '../errors';
import { stripMarkdownJsonFence } from './outputSchema';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:generation');

/**
 * Keys a text-encoded tool call names the tool with. `name` is what the
 * OpenAI/xAI function-calling wire format uses and by far the common case;
 * the rest are the shapes models improvise when they narrate a call instead
 * of emitting one.
 */
const NAME_KEYS = ['name', 'tool', 'tool_name', 'toolName', 'function'];

/**
 * Every key a blob may carry and still be read as *only* a tool invocation.
 * A real answer that happens to be JSON almost always carries a key outside
 * this vocabulary, and one such key is enough to leave the text alone — the
 * detector's job is to catch a blob that is nothing but a call, not to
 * adjudicate JSON answers in general.
 */
const TOOL_CALL_KEYS = new Set([
  ...NAME_KEYS,
  'arguments',
  'args',
  'parameters',
  'input',
  'id',
  'tool_call_id',
  'type',
]);

const readToolName = (
  value: Record<string, unknown>,
  toolNames: Set<string>
): string | null => {
  const keys = Object.keys(value);
  if (keys.length === 0) return null;

  const everyKeyIsToolCallVocabulary = keys.every((key) => {
    return TOOL_CALL_KEYS.has(key);
  });
  if (!everyKeyIsToolCallVocabulary) return null;

  for (const nameKey of NAME_KEYS) {
    const candidate = value[nameKey];
    if (typeof candidate === 'string' && toolNames.has(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * Detects an assistant message whose entire text is a tool invocation the
 * model wrote out instead of making — the shape that reached us as
 *
 * ```json
 * {"name": "get-fundamental-truth", "arguments": {}}
 * ```
 *
 * with `finishReason: "stop"`, `step_count: 1`, no `tool-call` part, and the
 * tool never executed. Nothing distinguished that generation from a real
 * answer, so the blob became the agent's `content` and every consumer
 * downstream ran on it.
 *
 * Deliberately narrow, because a false positive fails a generation that was
 * fine. All three must hold: the text (after a markdown fence is stripped) is
 * *entirely* one JSON object — or an array of them — every key of that object
 * belongs to tool-call vocabulary, and the name it carries is a tool actually
 * bound to this agent. A model naming a tool it does not have, or wrapping the
 * call in prose, is left alone; so is any text from an agent with no tools.
 *
 * Returns the invoked tool's name, or `null` when the text is an ordinary
 * answer.
 */
export const findTextEncodedToolCall = (args: {
  text: string;
  toolNames: string[];
}): string | null => {
  if (args.toolNames.length === 0) return null;

  const candidate = stripMarkdownJsonFence(args.text.trim()).trim();
  // Cheap reject before paying for a parse: the overwhelming majority of
  // answers are prose and never start with a brace or bracket.
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const toolNames = new Set(args.toolNames);

  if (isPlainObject(parsed)) return readToolName(parsed, toolNames);

  // A parallel-call array (`[{"name": …}, {"name": …}]`) is the same failure:
  // reported only when *every* element is a call, so a list that merely
  // contains one object shaped like a call is left alone.
  if (Array.isArray(parsed) && parsed.length > 0) {
    const names = parsed.map((entry) => {
      return isPlainObject(entry) ? readToolName(entry, toolNames) : null;
    });
    return names.every((name) => {
      return name !== null;
    })
      ? names[0]
      : null;
  }

  return null;
};

/**
 * The failure both generation paths raise, so a caller sees one error whether
 * the blob arrived on the initial turn or on a tool-outputs continuation.
 */
export const textEncodedToolCallError = (toolName: string): DomainError => {
  return new DomainError(
    'TEXT_ENCODED_TOOL_CALL',
    `The model wrote a call to tool '${toolName}' as plain text instead of invoking it, so the tool never ran and the text is not an answer.`,
    { tool_name: toolName }
  );
};

/**
 * Fails a generation whose final assistant text is a tool call the model wrote
 * out rather than made. Returning it as the answer is a silent data-integrity
 * failure — no error, no warning, `status: completed` — so the generation
 * fails loudly instead, the same way the `output_schema` path already does
 * when the model returns something that is not the shape it promised.
 *
 * Skipped when the agent has an `output_schema`: that path validates the model
 * output itself and already fails loudly, and its `content` is the serialized
 * object, which the detector has no business second-guessing.
 */
export const assertNoTextEncodedToolCall = (args: {
  text: string;
  toolNames: string[];
  outputSchema?: unknown;
  generationId: string;
}): void => {
  if (args.outputSchema) return;

  const toolName = findTextEncodedToolCall({
    text: args.text,
    toolNames: args.toolNames,
  });
  if (!toolName) return;

  log(
    'assertNoTextEncodedToolCall: generationId=%s model wrote a call to %s as text',
    args.generationId,
    toolName
  );

  throw textEncodedToolCallError(toolName);
};
