import type { HelpFlag, ParsedFlags, RouteLike, Wrapper } from './types.js';
import { formationsWrapper } from './wrappers/formations.js';

const WRAPPERS: Wrapper[] = [formationsWrapper];

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

export const getWrapperHelpFlags = (commandName: string): HelpFlag[] => {
  const wrapper = WRAPPERS.find((w) => {
    return w.commands.includes(commandName);
  });
  return wrapper?.helpFlags ?? [];
};

export { parseUnknownWithRepeats } from './flagParser.js';
export type { HelpFlag, ParsedFlags, Wrapper } from './types.js';
