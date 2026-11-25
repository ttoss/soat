import createDebug from 'debug';

import { DomainError } from '../errors';
import { mediaTypeModality } from './inputModalities';
import { countPdfPages } from './pdf';

const log = createDebug('soat:input-limits');

/** The modalities a byte limit is declared for: every file part is one of them. */
const BYTE_LIMITED_MODALITIES = ['image', 'file', 'audio', 'video'] as const;

type ByteLimitedModality = (typeof BYTE_LIMITED_MODALITIES)[number];

/** What one model declares it reads per request; an absent limit is unknown, not unlimited. */
export type InputLimits = {
  max_bytes?: Partial<Record<ByteLimitedModality, number>>;
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

const isByteLimits = (value: unknown): boolean => {
  return (
    isRecord(value) &&
    Object.entries(value).every(([modality, max]) => {
      return (
        BYTE_LIMITED_MODALITIES.some((known) => {
          return known === modality;
        }) && isPositiveInteger(max)
      );
    })
  );
};

const isInputLimits = (value: unknown): value is InputLimits => {
  return (
    isRecord(value) &&
    Object.entries(value).every(([limit, max]) => {
      if (limit === 'max_bytes') return isByteLimits(max);
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
    `model_input_limits maps a model name to positive integers: max_parts, max_pages, and max_bytes per ${BYTE_LIMITED_MODALITIES.join(', ')}.`
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

/** Where a file part sits in the prompt, as a refusal names it. */
export type PartPosition = {
  message_index: number;
  part_index: number;
  content_index?: number;
};

type FilePart = {
  position: PartPosition;
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

const filePart = (part: unknown, position: PartPosition): FilePart[] => {
  if (field(part, 'type') !== 'file') return [];
  return [
    {
      position,
      mediaType: String(field(part, 'mediaType')),
      bytes: bytesOf(part),
    },
  ];
};

const contentOf = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

// A tool result read natively carries its files under `output.value`.
const toolResultFiles = (part: unknown, base: PartPosition): FilePart[] => {
  const output = field(part, 'output');
  if (field(output, 'type') !== 'content') return [];
  return contentOf(field(output, 'value')).flatMap((content, index) => {
    return filePart(content, { ...base, content_index: index });
  });
};

const fileParts = (prompt: readonly unknown[]): FilePart[] => {
  return prompt.flatMap((message, messageIndex) => {
    return contentOf(field(message, 'content')).flatMap((part, partIndex) => {
      const position = { message_index: messageIndex, part_index: partIndex };
      return field(part, 'type') === 'tool-result'
        ? toolResultFiles(part, position)
        : filePart(part, position);
    });
  });
};

type Exceeded = {
  limit: 'max_bytes' | 'max_pages' | 'max_parts';
  modality?: string;
  max: number;
  value: number;
  part: FilePart;
};

const exceededByPart = async (args: {
  limits: InputLimits;
  part: FilePart;
}): Promise<Exceeded | null> => {
  const { limits, part } = args;
  if (!part.bytes) return null;
  const modality = mediaTypeModality(part.mediaType);
  const maxBytes = limits.max_bytes?.[modality as ByteLimitedModality];
  if (maxBytes !== undefined && part.bytes.byteLength > maxBytes) {
    const value = part.bytes.byteLength;
    return { limit: 'max_bytes', modality, max: maxBytes, value, part };
  }
  if (limits.max_pages === undefined || part.mediaType !== 'application/pdf') {
    return null;
  }
  const pages = await countPdfPages({ bytes: part.bytes });
  return pages > limits.max_pages
    ? {
        limit: 'max_pages',
        modality,
        max: limits.max_pages,
        value: pages,
        part,
      }
    : null;
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
  fileIdAt: (position: PartPosition) => string | null;
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
  const fileId = args.fileIdAt(exceeded.part.position);
  const part = {
    ...exceeded.part.position,
    ...(fileId ? { file_id: fileId } : {}),
  };
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
