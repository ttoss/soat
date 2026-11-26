import createDebug from 'debug';

import { DomainError } from '../errors';
import { mediaTypeModality } from './inputModalities';
import { readMediaDuration } from './mediaDuration';
import { countPdfPages } from './pdf';

const log = createDebug('soat:input-limits');

/** The modalities a byte limit is declared for: every file part is one of them. */
const BYTE_LIMITED_MODALITIES = ['image', 'file', 'audio', 'video'] as const;

type ByteLimitedModality = (typeof BYTE_LIMITED_MODALITIES)[number];

/** The modalities a duration limit is declared for. */
const TIMED_MODALITIES = ['audio', 'video'] as const;

type TimedModality = (typeof TIMED_MODALITIES)[number];

/** What one model declares it reads per request; an absent limit is unknown, not unlimited. */
export type InputLimits = {
  max_bytes?: Partial<Record<ByteLimitedModality, number>>;
  max_duration_seconds?: Partial<Record<TimedModality, number>>;
  max_pages?: number;
  max_parts?: number;
};

/** Model name → its input limits, as an AI provider declares. */
export type ModelInputLimits = Record<string, InputLimits>;

const COUNT_LIMITS = ['max_pages', 'max_parts'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
};

const isModalityLimits = (
  value: unknown,
  modalities: readonly string[]
): boolean => {
  return (
    isRecord(value) &&
    Object.entries(value).every(([modality, max]) => {
      return modalities.includes(modality) && isPositiveInteger(max);
    })
  );
};

/** The limits declared per modality, and the modalities each one names. */
const MODALITY_LIMITS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['max_bytes', BYTE_LIMITED_MODALITIES],
  ['max_duration_seconds', TIMED_MODALITIES],
]);

const isInputLimits = (value: unknown): value is InputLimits => {
  return (
    isRecord(value) &&
    Object.entries(value).every(([limit, max]) => {
      const modalities = MODALITY_LIMITS.get(limit);
      if (modalities) return isModalityLimits(max, modalities);
      return (
        COUNT_LIMITS.some((known) => {
          return known === limit;
        }) && isPositiveInteger(max)
      );
    })
  );
};

/**
 * Refuses a declaration the gate could not read. Formations write it without
 * the REST schema, so the shape is checked here, where every writer passes.
 */
export const assertModelInputLimits = (value: unknown): void => {
  if (value === undefined || value === null) return;
  const valid =
    isRecord(value) &&
    Object.entries(value).every(([model, limits]) => {
      return model !== '' && isInputLimits(limits);
    });
  if (valid) return;
  throw new DomainError(
    'VALIDATION_FAILED',
    `model_input_limits maps a model name to positive integers: max_parts, max_pages, max_bytes per ${BYTE_LIMITED_MODALITIES.join(', ')}, and max_duration_seconds per ${TIMED_MODALITIES.join(', ')}.`
  );
};

/** A stored declaration as the gate reads it: a value it cannot read declares nothing. */
export const readModelInputLimits = (
  stored: Record<string, unknown> | null | undefined
): ModelInputLimits => {
  const declared: ModelInputLimits = {};
  for (const [model, limits] of Object.entries(stored ?? {})) {
    if (isInputLimits(limits)) declared[model] = limits;
  }
  return declared;
};

/** The limits `model` declares on a provider, `null` when it declares none. */
export const limitsFor = (args: {
  modelInputLimits: ModelInputLimits | null | undefined;
  model: string;
}): InputLimits | null => {
  return args.modelInputLimits?.[args.model] ?? null;
};

/**
 * Where a file part sits, as a refusal names it: `message_index` counts the
 * conversation's messages, never the system prompt the runtime prepends.
 */
export type PartPosition = {
  message_index: number;
  part_index: number;
  content_index?: number;
};

/** A part's message as indexed in the prompt the provider is sent. */
export type PromptPosition = { promptIndex: number; partIndex: number };

type FilePart = {
  position: PartPosition;
  at: PromptPosition;
  mediaType: string;
  /** `null` for a part sent by URL, whose bytes the runtime never holds. */
  bytes: Uint8Array | null;
};

// Messages are typed by the provider SDK; only the fields read here matter.
const field = (value: unknown, key: string): unknown => {
  return Reflect.get(Object(value), key);
};

const bytesOf = (part: unknown): Uint8Array | null => {
  const data = field(part, 'data');
  if (field(data, 'type') !== 'data') return null;
  const value = field(data, 'data');
  if (value instanceof Uint8Array) return value;
  return typeof value === 'string' ? Buffer.from(value, 'base64') : null;
};

const filePart = (
  part: unknown,
  position: PartPosition,
  at: PromptPosition
): FilePart[] => {
  if (field(part, 'type') !== 'file') return [];
  return [
    {
      position,
      at,
      mediaType: String(field(part, 'mediaType')),
      bytes: bytesOf(part),
    },
  ];
};

const contentOf = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

// A tool result read natively carries its files under `output.value`.
const toolResultFiles = (
  part: unknown,
  base: PartPosition,
  at: PromptPosition
): FilePart[] => {
  const output = field(part, 'output');
  if (field(output, 'type') !== 'content') return [];
  return contentOf(field(output, 'value')).flatMap((content, index) => {
    return filePart(content, { ...base, content_index: index }, at);
  });
};

const fileParts = (prompt: readonly unknown[]): FilePart[] => {
  const conversation = prompt.flatMap((message, promptIndex) => {
    return field(message, 'role') === 'system'
      ? []
      : [{ message, promptIndex }];
  });
  return conversation.flatMap(({ message, promptIndex }, messageIndex) => {
    return contentOf(field(message, 'content')).flatMap((part, partIndex) => {
      const position = { message_index: messageIndex, part_index: partIndex };
      const at = { promptIndex, partIndex };
      return field(part, 'type') === 'tool-result'
        ? toolResultFiles(part, position, at)
        : filePart(part, position, at);
    });
  });
};

type Exceeded = {
  limit: 'max_bytes' | 'max_duration_seconds' | 'max_pages' | 'max_parts';
  modality?: string;
  max: number;
  /** `null` when the part's bytes do not say: its duration is unreadable. */
  value: number | null;
  part: FilePart;
};

type PartCheck = (args: {
  limits: InputLimits;
  part: FilePart & { bytes: Uint8Array };
  modality: string;
}) => Promise<Omit<Exceeded, 'part' | 'modality'> | null>;

const isTimedModality = (modality: string): modality is TimedModality => {
  return TIMED_MODALITIES.some((known) => {
    return known === modality;
  });
};

const byteCheck: PartCheck = async ({ limits, part, modality }) => {
  const max = limits.max_bytes?.[modality as ByteLimitedModality];
  const value = part.bytes.byteLength;
  return max !== undefined && value > max
    ? { limit: 'max_bytes', max, value }
    : null;
};

const durationCheck: PartCheck = async ({ limits, part, modality }) => {
  if (!isTimedModality(modality)) return null;
  const max = limits.max_duration_seconds?.[modality];
  if (max === undefined) return null;
  const seconds = readMediaDuration({ bytes: part.bytes });
  if (seconds !== null && seconds <= max) return null;
  const value = seconds === null ? null : Math.round(seconds * 1000) / 1000;
  return { limit: 'max_duration_seconds', max, value };
};

const pageCheck: PartCheck = async ({ limits, part }) => {
  const max = limits.max_pages;
  if (max === undefined || part.mediaType !== 'application/pdf') return null;
  const value = await countPdfPages({ bytes: part.bytes });
  return value > max ? { limit: 'max_pages', max, value } : null;
};

/** Every limit read off one part's bytes, cheapest first. */
const PART_CHECKS: readonly PartCheck[] = [byteCheck, durationCheck, pageCheck];

const exceededByPart = async (args: {
  limits: InputLimits;
  part: FilePart;
}): Promise<Exceeded | null> => {
  const { limits, part } = args;
  const { bytes } = part;
  if (!bytes) return null;
  const modality = mediaTypeModality(part.mediaType);
  for (const check of PART_CHECKS) {
    const exceeded = await check({
      limits,
      part: { ...part, bytes },
      modality,
    });
    if (exceeded) return { ...exceeded, modality, part };
  }
  return null;
};

const firstExceeded = async (args: {
  limits: InputLimits;
  parts: FilePart[];
}): Promise<Exceeded | null> => {
  const { limits, parts } = args;
  if (limits.max_parts !== undefined && parts.length > limits.max_parts) {
    return {
      limit: 'max_parts',
      max: limits.max_parts,
      value: parts.length,
      part: parts[limits.max_parts],
    };
  }
  for (const part of parts) {
    const exceeded = await exceededByPart({ limits, part });
    if (exceeded) return exceeded;
  }
  return null;
};

/**
 * Refuses, before the provider is called, a prompt over a limit its model
 * declares. `fileIdAt` names the stored file a part was read from, if any.
 */
export const assertWithinInputLimits = async (args: {
  model: string;
  limits: InputLimits | null;
  prompt: readonly unknown[];
  fileIdAt: (at: PromptPosition) => string | null;
}): Promise<void> => {
  if (!args.limits) return;
  const exceeded = await firstExceeded({
    limits: args.limits,
    parts: fileParts(args.prompt),
  });
  if (!exceeded) return;
  log(
    'assertWithinInputLimits: model=%s refused %s',
    args.model,
    exceeded.limit
  );
  const fileId = args.fileIdAt(exceeded.part.at);
  const part = {
    ...exceeded.part.position,
    ...(fileId ? { file_id: fileId } : {}),
  };
  if (exceeded.value === null) {
    throw new DomainError(
      'MEDIA_PARSE_FAILED',
      `Model '${args.model}' accepts ${exceeded.limit} ${exceeded.max} for ${exceeded.modality} input, and the part's duration could not be read from its bytes.`,
      {
        model: args.model,
        limit: exceeded.limit,
        modality: exceeded.modality,
        part,
      }
    );
  }
  throw new DomainError(
    'INPUT_LIMIT_EXCEEDED',
    `Model '${args.model}' accepts ${exceeded.limit} ${exceeded.max}${exceeded.modality ? ` for ${exceeded.modality} input` : ''}; the request carries ${exceeded.value}.`,
    {
      model: args.model,
      limit: exceeded.limit,
      ...(exceeded.modality ? { modality: exceeded.modality } : {}),
      max: exceeded.max,
      value: exceeded.value,
      part,
    }
  );
};
