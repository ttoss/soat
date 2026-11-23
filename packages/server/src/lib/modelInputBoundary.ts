import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { wrapLanguageModel } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { readFileBuffer } from './fileStorage';
import { type InputModality, readInputModalities } from './inputModalities';
import {
  inputModalityRefusal,
  missingModalities,
  registerInputGate,
} from './inputModalityGate';

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
}): Promise<Uint8Array> => {
  const file = await db.File.findOne({
    where: { publicId: args.fileId, projectId: args.projectId },
    attributes: ['storageType', 'storagePath'],
  });
  const bytes = file ? await readFileBuffer(file) : null;
  if (!bytes) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `File '${args.fileId}' not found.`
    );
  }
  return new Uint8Array(bytes);
};

const withFileBytes = async (args: {
  part: UserPart;
  projectId: number;
}): Promise<UserPart> => {
  const { part } = args;
  const fileId = referencedFileId(part);
  if (fileId === null || part.type !== 'file') return part;
  log('withFileBytes: fileId=%s projectId=%d', fileId, args.projectId);
  const data = await readReferencedFile({ fileId, projectId: args.projectId });
  return { ...part, data: { type: 'data', data } };
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

const withFileReferenceUrls = (urls: SupportedUrls): SupportedUrls => {
  return { ...urls, '*': [...(urls['*'] ?? []), FILE_REFERENCE_URL] };
};

/**
 * Every model a provider row serves crosses this boundary
 * (`modelPricingGate.ts`): a call carrying input the model declares it cannot
 * read is refused before it leaves, and a file reference becomes its bytes.
 */
export const withInputBoundary = (args: {
  model: LanguageModel;
  modelName: string;
  accepted: readonly InputModality[] | null;
  projectId: number;
}): LanguageModel => {
  /* istanbul ignore next -- every provider builder returns a model object. */
  if (typeof args.model === 'string') return args.model;
  const middleware: LanguageModelMiddleware = {
    overrideSupportedUrls: async ({ model }) => {
      return withFileReferenceUrls(await model.supportedUrls);
    },
    transformParams: async ({ params }) => {
      const missing = missingModalities({
        accepted: args.accepted,
        required: readInputModalities(params.prompt),
      });
      if (missing.length > 0) {
        throw inputModalityRefusal({ model: args.modelName, missing });
      }
      return {
        ...params,
        prompt: await resolveFileReferences({
          prompt: params.prompt,
          projectId: args.projectId,
        }),
      };
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

export { FILE_REFERENCE_URL };
