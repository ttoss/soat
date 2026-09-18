/**
 * Telling the model that a tool it is configured to have could not be reached.
 *
 * The resolver drops such a binding rather than failing the turn, which is the
 * right call — one flaky server must not take an agent down. But a turn that
 * ran without its tools is indistinguishable, from inside the model, from an
 * agent that never had them: it answers that it has no such capability, or
 * invents a cause for a failure it was never shown. No instruction an author
 * writes can defend against that, because the information never arrives.
 *
 * A note, not a stub tool: an `mcp` binding's tool names and schemas come from
 * the listing that just failed, so there is nothing to build a stub from, and
 * one mechanism that covers every binding type beats two that split by it.
 */
import createDebug from 'debug';

const log = createDebug('soat:generation');

/** Called once per binding that contributed no tool to the turn. */
export type UnavailableToolSink = (args: { toolName: string }) => void;

/**
 * The names, in binding order and without repeats, plus the sink the resolver
 * reports into.
 */
export const collectUnavailableTools = (): {
  names: string[];
  sink: UnavailableToolSink;
} => {
  const seen = new Set<string>();
  const names: string[] = [];
  return {
    names,
    sink: ({ toolName }) => {
      if (seen.has(toolName)) return;
      seen.add(toolName);
      names.push(toolName);
    },
  };
};

/**
 * The note's text. It names the tools and says nothing about why: the recorded
 * reason is operator-grade (an upstream status code, an exception message, a
 * secret-reference error) and belongs on the activity feed, not in context the
 * model may repeat to an end user. Naming the tools is what lets the model be
 * specific without guessing, and costs no retries — an unavailable tool is not
 * in the surface, so there is nothing to call.
 */
const unavailableToolsNote = (toolNames: string[]): string => {
  return [
    `These tools are configured for you but are unavailable for this turn and cannot be called: ${toolNames.join(', ')}.`,
    'If answering needs one of them, say plainly that the tool is currently unavailable and that you could not reach it. Do not state a cause, and do not say you lack the capability.',
  ].join('\n');
};

const isSystem = (message: { role: string }): boolean => {
  return message.role === 'system';
};

/**
 * Inserts the note at the end of the leading system block, so it is read as
 * instruction rather than as conversation, and so the prompt-cache breakpoint —
 * which marks the last system message — still lands at the end of the static
 * prefix.
 *
 * A note already present is left alone: a generation that pauses and resumes
 * re-resolves its surface against the history it already carries, and the same
 * tools being unavailable twice is one fact, not two.
 */
export const withUnavailableToolsNote = <
  T extends { role: string; content: unknown },
>(args: {
  messages: T[];
  unavailableToolNames: string[];
}): Array<T | { role: string; content: string }> => {
  if (args.unavailableToolNames.length === 0) return args.messages;

  const content = unavailableToolsNote(args.unavailableToolNames);
  if (
    args.messages.some((message) => {
      return isSystem(message) && message.content === content;
    })
  ) {
    return args.messages;
  }

  log('withUnavailableToolsNote: tools=%o', args.unavailableToolNames);

  const leadingSystem = args.messages.findIndex((message) => {
    return !isSystem(message);
  });
  const insertAt = leadingSystem === -1 ? args.messages.length : leadingSystem;

  return [
    ...args.messages.slice(0, insertAt),
    { role: 'system', content },
    ...args.messages.slice(insertAt),
  ];
};
