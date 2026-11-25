import createDebug from 'debug';

import { DomainError } from '../errors';
import {
  canonicalTimezone,
  formatClock,
  ISO_CLOCK_PATTERN,
  isValidClockPattern,
} from './clockFormat';
import { TEMPLATE_TOKEN_RE } from './toolTemplates';

const log = createDebug('soat:instructionTemplates');

/**
 * The `{{generation:...}}` tokens an agent's `instructions` may hold, resolved
 * against the generation's clock when its context is built. A `{{...}}` token
 * of any other kind is left as written: only the `generation:` namespace is
 * reserved here, and it is closed — an unknown name or a bad argument is
 * refused at write.
 */

export const DEFAULT_TIMEZONE = 'UTC';

/** The instant a generation starts and the timezone its tokens render in. */
export type GenerationClock = { now: Date; timezone: string };

type GenerationToken = {
  syntax: string;
  accepts: (arg: string | undefined) => boolean;
  resolve: (args: {
    clock: GenerationClock;
    arg: string | undefined;
  }) => string;
};

const GENERATION_TOKENS: Record<string, GenerationToken> = {
  now: {
    syntax: '{{generation:now}}, {{generation:now:<format>}}',
    accepts: (arg) => {
      return arg === undefined || isValidClockPattern(arg);
    },
    resolve: ({ clock, arg }) => {
      return formatClock({ ...clock, pattern: arg ?? ISO_CLOCK_PATTERN });
    },
  },
  timezone: {
    syntax: '{{generation:timezone}}',
    accepts: (arg) => {
      return arg === undefined;
    },
    resolve: ({ clock }) => {
      return clock.timezone;
    },
  },
};

const PREFIX = 'generation:';

type ParsedToken =
  | { kind: 'other' }
  | { kind: 'invalid' }
  | { kind: 'valid'; token: GenerationToken; arg: string | undefined };

const parseToken = (inner: string): ParsedToken => {
  if (!inner.startsWith(PREFIX)) return { kind: 'other' };
  const rest = inner.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  const name = colon === -1 ? rest : rest.slice(0, colon);
  const arg = colon === -1 ? undefined : rest.slice(colon + 1);
  if (!Object.hasOwn(GENERATION_TOKENS, name)) return { kind: 'invalid' };
  const token = GENERATION_TOKENS[name];
  return token.accepts(arg)
    ? { kind: 'valid', token, arg }
    : { kind: 'invalid' };
};

/** The `{{generation:...}}` tokens in `text` that name nothing valid. */
export const findInvalidInstructionTokens = (text: string): string[] => {
  return [...text.matchAll(TEMPLATE_TOKEN_RE)]
    .filter((match) => {
      return parseToken(match[1]).kind === 'invalid';
    })
    .map((match) => {
      return match[0];
    });
};

export const VALID_INSTRUCTION_TOKENS = Object.values(GENERATION_TOKENS)
  .map((token) => {
    return token.syntax;
  })
  .join(', ');

export const assertValidInstructionTokens = (
  instructions: string | null | undefined
): void => {
  if (typeof instructions !== 'string') return;
  const invalid = [...new Set(findInvalidInstructionTokens(instructions))];
  if (invalid.length === 0) return;
  throw new DomainError(
    'VALIDATION_FAILED',
    `instructions holds ${invalid
      .map((t) => {
        return `'${t}'`;
      })
      .join(
        ', '
      )}, which is not a valid token; the valid ones are ${VALID_INSTRUCTION_TOKENS}.`,
    { invalid_tokens: invalid }
  );
};

/** The timezone stored or requested, canonical; any other value is a 400. */
export const requireTimezone = (args: {
  value: unknown;
  field: string;
}): string => {
  const timezone = canonicalTimezone(args.value);
  if (timezone !== null) return timezone;
  throw new DomainError(
    'VALIDATION_FAILED',
    `${args.field} must be an IANA timezone name, such as 'America/Sao_Paulo' or 'UTC'.`,
    { [args.field]: args.value }
  );
};

/**
 * The clock a generation's tokens resolve against: a timezone the request
 * names overrides the agent's own.
 */
export const resolveGenerationClock = (args: {
  requestedTimezone?: unknown;
  agentTimezone: unknown;
}): GenerationClock => {
  const timezone =
    args.requestedTimezone === undefined
      ? (canonicalTimezone(args.agentTimezone) ?? DEFAULT_TIMEZONE)
      : requireTimezone({ value: args.requestedTimezone, field: 'timezone' });
  return { now: new Date(), timezone };
};

/** `instructions` with every valid `{{generation:...}}` token resolved. */
export const resolveInstructionTokens = (args: {
  instructions: string | null;
  clock: GenerationClock;
}): string | null => {
  if (!args.instructions) return args.instructions;
  log('resolveInstructionTokens: timezone=%s', args.clock.timezone);
  return args.instructions.replace(TEMPLATE_TOKEN_RE, (whole, inner) => {
    const parsed = parseToken(String(inner));
    return parsed.kind === 'valid'
      ? parsed.token.resolve({ clock: args.clock, arg: parsed.arg })
      : whole;
  });
};
