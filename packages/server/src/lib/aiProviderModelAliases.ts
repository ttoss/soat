import type { LanguageModelMiddleware } from 'ai';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/** What a provider row carries about the names it serves. */
export type ModelAliasing = {
  /** Absent on a provider being created. */
  publicId?: string;
  modelAliases: Record<string, string> | null;
  modelAliasesOnly: boolean;
};

/** Refuses a `model_aliases` that is not an object of non-empty strings. */
export const assertModelAliases = (value: unknown): void => {
  if (value === null || value === undefined) return;
  if (!isPlainObject(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'model_aliases must be an object mapping each alias to the model id sent to the vendor.'
    );
  }
  for (const [alias, vendorModel] of Object.entries(value)) {
    if (alias === '' || typeof vendorModel !== 'string' || vendorModel === '') {
      throw new DomainError(
        'VALIDATION_FAILED',
        `model_aliases.${alias || '""'} must map a non-empty alias to a non-empty model id.`
      );
    }
  }
};

/** Refuses a model a closed provider does not offer. */
export const assertModelOffered = (args: {
  aiProvider: ModelAliasing;
  model: string;
}): void => {
  const { aiProvider, model } = args;
  if (!aiProvider.modelAliasesOnly) return;
  if (
    aiProvider.modelAliases &&
    Object.hasOwn(aiProvider.modelAliases, model)
  ) {
    return;
  }
  const subject = aiProvider.publicId
    ? `AI provider '${aiProvider.publicId}'`
    : 'This AI provider';
  throw new DomainError(
    'MODEL_NOT_OFFERED',
    `${subject} serves only its model_aliases; '${model}' is not one of them.`,
    { ai_provider_id: aiProvider.publicId ?? null, model }
  );
};

/** The model id the vendor is called with for a name stored beside `aiProvider`. */
export const resolveVendorModel = (args: {
  aiProvider: ModelAliasing;
  model: string;
}): string => {
  assertModelOffered(args);
  const aliases = args.aiProvider.modelAliases;
  return aliases && Object.hasOwn(aliases, args.model)
    ? aliases[args.model]
    : args.model;
};

/** Reports `alias` wherever the vendor would report the id it was called with. */
export const answeringAs = (alias: string): LanguageModelMiddleware => {
  return {
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      if (!result.response) return result;
      return { ...result, response: { ...result.response, modelId: alias } };
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform: (part, controller) => {
              controller.enqueue(
                part.type === 'response-metadata'
                  ? { ...part, modelId: alias }
                  : part
              );
            },
          })
        ),
      };
    },
  };
};
