import type { ParsedFlags, RouteLike, Wrapper } from './types.js';
import { agentFormationsWrapper } from './wrappers/agentFormations.js';

const WRAPPERS: Wrapper[] = [agentFormationsWrapper];

const resolveWrapperForCommand = (args: {
  commandName: string;
}): Wrapper | undefined => {
  const { commandName } = args;

  return WRAPPERS.find((wrapper) => {
    return wrapper.commands.includes(commandName);
  });
};

export const applyWrapperForCommand = (args: {
  commandName: string;
  route: RouteLike;
  parsedFlags: ParsedFlags;
}): { flags: ParsedFlags; forcedBody: Record<string, unknown> } => {
  const { commandName, route, parsedFlags } = args;
  const wrapper = resolveWrapperForCommand({ commandName });

  if (!wrapper) {
    return { flags: parsedFlags, forcedBody: {} };
  }

  return wrapper.apply({
    context: {
      commandName,
      route,
      parsedFlags,
    },
  });
};

export { parseUnknownWithRepeats } from './flagParser.js';
export type { ParsedFlags, Wrapper } from './types.js';
