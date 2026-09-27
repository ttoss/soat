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

/**
 * What to report for a 2xx payload whose own body says the operation failed,
 * or null when there is nothing wrong with it. Drives the CLI's exit code.
 */
export const resolveFailureMessage = (args: {
  commandName: string;
  data: unknown;
}): string | null => {
  const wrapper = resolveWrapperForCommand({ commandName: args.commandName });

  return (
    wrapper?.failureMessage?.({
      commandName: args.commandName,
      data: args.data,
    }) ?? null
  );
};

export const getWrapperHelpFlags = (commandName: string): HelpFlag[] => {
  const wrapper = WRAPPERS.find((w) => {
    return w.commands.includes(commandName);
  });
  return wrapper?.helpFlags ?? [];
};

export {
  buildArrayFlagValue,
  extractPositionalArgs,
  parseFlagValue,
  parseUnknownWithRepeats,
} from './flagParser.js';
export type { HelpFlag, ParsedFlags, Wrapper } from './types.js';
