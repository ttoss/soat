import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { wrapLanguageModel } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { readFileBuffer } from './fileStorage';
import {
  assertWithinInputLimits,
  type InputLimits,
  type PartPosition,
} from './inputLimits';
import { type InputModality, readInputModalities } from './inputModalities';
import {
  inputModalityRefusal,
  missingModalities,
  registerInputGate,
} from './inputModalityGate';
import { toolOutputParts } from './toolResultFiles';

const log = createDebug('soat:model-input');

/**
 * A message names a stored file by this URL, never by its bytes, so a stored
 * generation, a paused turn and a replayed turn carry the reference only. The
 * bytes are read here, as the call leaves for the provider.
 */
const FILE_REFERENCE_SCHEME = 'soat-file:';

const FILE_REFERENCE_URL = /^soat-file:/;

export const fileReferenceUrl = (fileId: string): string => {
  return `${FILE_REFERENCE_SCHEME}${fileId}`;
};

type CallParams = Parameters<
  NonNullable<LanguageModelMiddleware['transformParams']>
>[0]['params'];
type PromptMessage = CallParams['prompt'][number];
type UserMessage = Extract<PromptMessage, { role: 'user' }>;
type UserPart = UserMessage['content'][number];
type ToolMessage = Extract<PromptMessage, { role: 'tool' }>;
type ToolPart = ToolMessage['content'][number];
type ToolContent = Extract<
  Extract<ToolPart, { type: 'tool-result' }>['output'],
  { type: 'content' }
>['value'][number];
type SupportedUrls = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware['overrideSupportedUrls']>>
>;

const referencedFileId = (part: UserPart): string | null => {
  if (part.type !== 'file' || part.data.type !== 'url') return null;
  const url = String(part.data.url);
  return url.startsWith(FILE_REFERENCE_SCHEME)
    ? url.slice(FILE_REFERENCE_SCHEME.length)
    : null;
};

/** Held to the turn's project, where the message naming it was resolved. */
const readReferencedFile = async (args: {
  fileId: string;
  projectId: number;
}): Promise<{ bytes: Buffer; mediaType: string; filename: string | null }> => {
  const file = await db.File.findOne({
    where: { publicId: args.fileId, projectId: args.projectId },
    attributes: ['storageType', 'storagePath', 'contentType', 'filename'],
  });
  const bytes = file ? await readFileBuffer(file) : null;
  if (!file || !bytes) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `File '${args.fileId}' not found.`
    );
  }
  return {
    bytes,
    mediaType: file.contentType ?? 'application/octet-stream',
    filename: file.filename ?? null,
  };
};

const withFileBytes = async (args: {
  part: UserPart;
  projectId: number;
}): Promise<UserPart> => {
  const { part } = args;
  const fileId = referencedFileId(part);
  if (fileId === null || part.type !== 'file') return part;
  log('withFileBytes: fileId=%s projectId=%d', fileId, args.projectId);
  const file = await readReferencedFile({ fileId, projectId: args.projectId });
  return { ...part, data: { type: 'data', data: new Uint8Array(file.bytes) } };
};

// Only a user message is resolved: a reference anywhere else reaches the
// provider as a URL it cannot fetch, so it never carries a file's bytes.
const resolveFileReferences = (args: {
  prompt: CallParams['prompt'];
  projectId: number;
}): Promise<CallParams['prompt']> => {
  return Promise.all(
    args.prompt.map(async (message): Promise<PromptMessage> => {
      if (message.role !== 'user') return message;
      const content = await Promise.all(
        message.content.map((part) => {
          return withFileBytes({ part, projectId: args.projectId });
        })
      );
      return { ...message, content };
    })
  );
};

// A tool result returning files (`toolResultFiles.ts`) becomes native parts,
// base64 so a provider that sends tool results as text still carries them.
const toolContentOf = async (args: {
  value: unknown;
  projectId: number;
}): Promise<ToolContent[] | null> => {
  const parts = toolOutputParts(args.value);
  if (!parts) return null;
  return Promise.all(
    parts.map(async (part): Promise<ToolContent> => {
      if (part.type === 'text') return part;
      log(
        'toolContentOf: fileId=%s projectId=%d',
        part.file_id,
        args.projectId
      );
      const file = await readReferencedFile({
        fileId: part.file_id,
        projectId: args.projectId,
      });
      return {
        type: 'file',
        data: { type: 'data', data: file.bytes.toString('base64') },
        mediaType: file.mediaType,
        ...(file.filename ? { filename: file.filename } : {}),
      };
    })
  );
};

const withToolResultFiles = async (args: {
  part: ToolPart;
  projectId: number;
}): Promise<ToolPart> => {
  const { part } = args;
  if (part.type !== 'tool-result' || part.output.type !== 'json') return part;
  const value = await toolContentOf({
    value: part.output.value,
    projectId: args.projectId,
  });
  return value ? { ...part, output: { type: 'content', value } } : part;
};

const resolveToolResultFiles = (args: {
  prompt: CallParams['prompt'];
  projectId: number;
}): Promise<CallParams['prompt']> => {
  return Promise.all(
    args.prompt.map(async (message): Promise<PromptMessage> => {
      if (message.role !== 'tool') return message;
      const content = await Promise.all(
        message.content.map((part) => {
          return withToolResultFiles({ part, projectId: args.projectId });
        })
      );
      return { ...message, content };
    })
  );
};

// Resolving keeps every part where it was, so a position in the resolved
// prompt names the same part in the prompt as sent.
const fileIdAt = (args: {
  prompt: CallParams['prompt'];
  position: PartPosition;
}): string | null => {
  const message = args.prompt[args.position.message_index];
  if (message?.role !== 'user') return null;
  const part = message.content[args.position.part_index];
  return part ? referencedFileId(part) : null;
};

const withFileReferenceUrls = (urls: SupportedUrls): SupportedUrls => {
  return { ...urls, '*': [...(urls['*'] ?? []), FILE_REFERENCE_URL] };
};

/**
 * Every model a provider row serves crosses this boundary
 * (`modelPricingGate.ts`): a call carrying input the model declares it cannot
 * read, or over a limit it declares, is refused before it leaves, and a file
 * reference becomes its bytes.
 */
export const withInputBoundary = (args: {
  model: LanguageModel;
  modelName: string;
  accepted: readonly InputModality[] | null;
  limits: InputLimits | null;
  projectId: number;
}): LanguageModel => {
  /* istanbul ignore next -- every provider builder returns a model object. */
  if (typeof args.model === 'string') return args.model;
  const middleware: LanguageModelMiddleware = {
    overrideSupportedUrls: async ({ model }) => {
      return withFileReferenceUrls(await model.supportedUrls);
    },
    transformParams: async ({ params }) => {
      const prompt = await resolveToolResultFiles({
        prompt: params.prompt,
        projectId: args.projectId,
      });
      const missing = missingModalities({
        accepted: args.accepted,
        required: readInputModalities(prompt),
      });
      if (missing.length > 0) {
        throw inputModalityRefusal({ model: args.modelName, missing });
      }
      const resolved = await resolveFileReferences({
        prompt,
        projectId: args.projectId,
      });
      await assertWithinInputLimits({
        model: args.modelName,
        limits: args.limits,
        prompt: resolved,
        fileIdAt: (position) => {
          return fileIdAt({ prompt, position });
        },
      });
      return { ...params, prompt: resolved };
    },
  };
  const wrapped = wrapLanguageModel({ model: args.model, middleware });
  registerInputGate({
    model: wrapped,
    missing: (required) => {
      return missingModalities({ accepted: args.accepted, required });
    },
  });
  return wrapped;
};

const INPUT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'INPUT_MODALITY_UNSUPPORTED',
  'INPUT_LIMIT_EXCEEDED',
  'PDF_PARSE_FAILED',
  'RESOURCE_NOT_FOUND',
]);

/** A refusal of the input this boundary decides, which no retry without tools answers. */
export const isInputBoundaryRefusal = (error: unknown): boolean => {
  return error instanceof DomainError && INPUT_REFUSAL_CODES.has(error.code);
};

export { FILE_REFERENCE_URL };
