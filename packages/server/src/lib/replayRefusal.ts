import { APICallError, RetryError } from 'ai';

import { DomainError } from '../errors';
import { SharedProviderFailure } from './providerError';

/** The conversation positions a turn sends the model, inclusive. */
export type ReplayedWindow = { firstPosition: number; lastPosition: number };

/** The window a conversation turn replays; `null` for a turn with none. */
export const replayedWindowOf = (
  conversation: { firstPosition: number; snapshotPosition: number } | undefined
): ReplayedWindow | null => {
  return conversation
    ? {
        firstPosition: conversation.firstPosition,
        lastPosition: conversation.snapshotPosition,
      }
    : null;
};

const REFUSAL_CAUSES = [
  'history_refused',
  'context_too_long',
  'request_refused',
] as const;

export type RefusalCause = (typeof REFUSAL_CAUSES)[number];

const CAUSE_KEY = 'refusal_cause';

const CAUSE_TEXT: Record<RefusalCause, string> = {
  history_refused: 'refused the replayed history',
  context_too_long: 'found the replayed history too long',
  request_refused: 'refused the request',
};

/**
 * How vendors say a prompt exceeds the model's context window. Anthropic,
 * OpenAI and Bedrock answer it with `400`, which the status alone reads as
 * `history_refused`.
 */
const CONTEXT_OVERFLOW_SIGNATURES: readonly RegExp[] = [
  /prompt is too long/i,
  /context_length_exceeded/i,
  /maximum context length/i,
  /exceeds the maximum number of tokens/i,
  /input tokens exceeds maximum length/i,
  /input is too long for requested model/i,
];

const overflowsContext = (args: { responseBody?: string }): boolean => {
  const body = args.responseBody ?? '';
  return CONTEXT_OVERFLOW_SIGNATURES.some((signature) => {
    return signature.test(body);
  });
};

/**
 * A vendor refusal: a non-retryable 4xx, classified from its status and body.
 * A retryable fault (408, 429, 5xx) says nothing about what the turn sent.
 */
const refusalCause = (args: {
  statusCode?: number;
  isRetryable: boolean;
  responseBody?: string;
}): RefusalCause | null => {
  const { statusCode } = args;
  if (args.isRetryable || statusCode === undefined) return null;
  if (statusCode < 400 || statusCode >= 500) return null;
  if (statusCode === 413 || overflowsContext(args)) return 'context_too_long';
  if (statusCode === 400) return 'history_refused';
  return 'request_refused';
};

const isRefusalCause = (value: unknown): value is RefusalCause => {
  return (REFUSAL_CAUSES as readonly unknown[]).includes(value);
};

const vendorCallError = (error: unknown): APICallError | null => {
  const unwrapped = RetryError.isInstance(error)
    ? (error.lastError ?? error)
    : error;
  if (APICallError.isInstance(unwrapped)) return unwrapped;
  const cause = unwrapped instanceof Error ? unwrapped.cause : undefined;
  return APICallError.isInstance(cause) ? cause : null;
};

const causeOf = (error: APICallError): RefusalCause | null => {
  const { data } = error;
  if (typeof data === 'object' && data !== null && CAUSE_KEY in data) {
    const carried = (data as Record<string, unknown>)[CAUSE_KEY];
    return isRefusalCause(carried) ? carried : null;
  }
  return refusalCause(error);
};

/**
 * The only way to rethrow a vendor fault without its message, body or URL: the
 * fault carries the refusal's classified cause as `data`, read back by
 * {@link replayRefusal}. A shared provider's also withholds the status.
 */
export const withheldVendorFault = (args: {
  error: unknown;
  message: string;
  shared: boolean;
  isRetryable: boolean;
}): APICallError => {
  const known = APICallError.isInstance(args.error) ? args.error : undefined;
  const cause = known ? causeOf(known) : null;
  const Fault = args.shared ? SharedProviderFailure : APICallError;
  return new Fault({
    message: args.message,
    url: '',
    requestBodyValues: {},
    statusCode: args.shared ? undefined : known?.statusCode,
    data: cause ? { [CAUSE_KEY]: cause } : {},
    isRetryable: args.isRetryable,
  });
};

/**
 * A turn that replays a conversation and is refused by the vendor fails as
 * `REPLAY_REFUSED`, naming the classified cause and the replayed window, never
 * the vendor's text. Any other error is returned unchanged.
 */
export const replayRefusal = (args: {
  error: unknown;
  replayed: ReplayedWindow | null;
}): unknown => {
  if (!args.replayed) return args.error;
  const vendorError = vendorCallError(args.error);
  const cause = vendorError ? causeOf(vendorError) : null;
  if (!cause) return args.error;
  const { firstPosition, lastPosition } = args.replayed;
  return new DomainError(
    'REPLAY_REFUSED',
    `The AI provider ${CAUSE_TEXT[cause]} (conversation positions ${firstPosition} to ${lastPosition}).`,
    {
      cause,
      replayed_window: {
        first_position: firstPosition,
        last_position: lastPosition,
      },
    }
  );
};
