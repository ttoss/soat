import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { APICallError, wrapLanguageModel } from 'ai';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/** An alias another provider of the same project serves, by its vendor id. */
export type ForwardedModel = { ai_provider_id: string; model: string };

/** What an alias maps to: a vendor id, or another provider's vendor id. */
export type ModelAliasTarget = string | ForwardedModel;

export type ModelAliases = Record<string, ModelAliasTarget>;

/** What a provider row carries about the names it serves. */
export type ModelAliasing = {
  /** Absent on a provider being created. */
  publicId?: string;
  modelAliases: ModelAliases | null;
  modelAliasesOnly: boolean;
};

export const isForwardedModel = (
  target: ModelAliasTarget
): target is ForwardedModel => {
  return typeof target !== 'string';
};

const FORWARDED_KEYS = ['ai_provider_id', 'model'];

const isValidTarget = (target: unknown): boolean => {
  if (typeof target === 'string') return target !== '';
  if (!isPlainObject(target)) return false;
  const keys = Object.keys(target);
  return (
    keys.length === FORWARDED_KEYS.length &&
    FORWARDED_KEYS.every((key) => {
      const value = target[key];
      return typeof value === 'string' && value !== '';
    })
  );
};

/** Refuses a `model_aliases` whose entries are neither vendor ids nor forwards. */
export const assertModelAliases = (value: unknown): void => {
  if (value === null || value === undefined) return;
  if (!isPlainObject(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'model_aliases must be an object mapping each alias to the model id sent to the vendor, or to `{ ai_provider_id, model }`.'
    );
  }
  for (const [alias, target] of Object.entries(value)) {
    if (alias === '' || !isValidTarget(target)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `model_aliases.${alias || '""'} must map a non-empty alias to a non-empty model id, or to \`{ ai_provider_id, model }\` with both non-empty.`,
        { field: `model_aliases.${alias}` }
      );
    }
  }
};

/** The public ids of the providers `aliases` forward to. */
export const forwardedProviderIds = (
  aliases: ModelAliases | null
): string[] => {
  const ids = Object.values(aliases ?? {}).flatMap((target) => {
    return isForwardedModel(target) ? [target.ai_provider_id] : [];
  });
  return [...new Set(ids)];
};

/**
 * A closed provider whose every alias forwards never calls a vendor through
 * its own endpoint, so it carries no credential of its own.
 */
export const forwardsEveryModel = (aiProvider: ModelAliasing): boolean => {
  const targets = Object.values(aiProvider.modelAliases ?? {});
  return (
    aiProvider.modelAliasesOnly &&
    targets.length > 0 &&
    targets.every(isForwardedModel)
  );
};

/** The names a closed provider offers, sorted; `null` for an open one. */
export const offeredAliases = (aiProvider: ModelAliasing): string[] | null => {
  if (!aiProvider.modelAliasesOnly) return null;
  return Object.keys(aiProvider.modelAliases ?? {}).sort();
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
    `${subject} does not serve '${model}'.`,
    { ai_provider_id: aiProvider.publicId ?? null, model }
  );
};

/**
 * Where a name stored beside `aiProvider` is served: the vendor id, and the
 * public id of the provider whose endpoint serves it when the alias forwards.
 */
export const resolveServedModel = (args: {
  aiProvider: ModelAliasing;
  model: string;
}): { vendorModel: string; forwardedTo: string | null } => {
  assertModelOffered(args);
  const aliases = args.aiProvider.modelAliases;
  const target =
    aliases && Object.hasOwn(aliases, args.model) ? aliases[args.model] : null;
  if (target === null) return { vendorModel: args.model, forwardedTo: null };
  if (isForwardedModel(target)) {
    return { vendorModel: target.model, forwardedTo: target.ai_provider_id };
  }
  return { vendorModel: target, forwardedTo: null };
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

/**
 * The fault a forwarded call reports: the vendor's status and retryability,
 * never its message, body or URL, which name the target and its vendor id.
 */
const forwardedFault = (args: {
  error: unknown;
  facadeId: string;
  alias: string;
}): APICallError => {
  const known = APICallError.isInstance(args.error) ? args.error : undefined;
  return new APICallError({
    message: `AI provider '${args.facadeId}' could not serve '${args.alias}'.`,
    url: '',
    requestBodyValues: {},
    statusCode: known?.statusCode,
    isRetryable: known?.isRetryable ?? false,
  });
};

/** Reports every fault of a forwarded call as the facade's and the alias's. */
export const faultingAs = (args: {
  facadeId: string;
  alias: string;
}): LanguageModelMiddleware => {
  const settled = async <T>(call: () => PromiseLike<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw forwardedFault({ ...args, error });
    }
  };
  return {
    wrapGenerate: async ({ doGenerate }) => {
      return settled(doGenerate);
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await settled(doStream);
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform: (part, controller) => {
              controller.enqueue(
                part.type === 'error'
                  ? {
                      ...part,
                      error: forwardedFault({ ...args, error: part.error }),
                    }
                  : part
              );
            },
          })
        ),
      };
    },
  };
};

/** The endpoint a vendor call goes through: slug, credential and settings. */
export type ModelEndpoint = {
  /** The public id of the project the provider record belongs to. */
  projectPublicId: string;
  provider: AiProviderSlug;
  secretValue: string | null;
  baseUrl?: string;
  config?: Record<string, unknown>;
};

/**
 * A provider row as `resolveAiProviderSecret` hands it out, with the endpoint
 * of every provider its aliases forward to, keyed by public id.
 */
export type ModelProvider = ModelAliasing &
  ModelEndpoint & {
    publicId: string;
    aliasTargets: Record<string, ModelEndpoint>;
    /** The project generating through another project's provider, else `null`. */
    grantee: number | null;
  };

/**
 * A forwarded alias is built on its target's endpoint, and every refusal or
 * fault names the facade and the alias, never the target or its vendor id.
 */
export const buildForwardedModel = (args: {
  aiProvider: ModelProvider;
  alias: string;
  targetId: string;
  vendorModel: string;
  build: (args: {
    endpoint: ModelEndpoint;
    vendorModel: string;
  }) => LanguageModel;
}): LanguageModel => {
  const facadeId = args.aiProvider.publicId;
  const misconfigured = new DomainError(
    'AI_PROVIDER_MISCONFIGURED',
    `AI provider '${facadeId}' cannot serve '${args.alias}': the provider it forwards to is missing or misconfigured.`,
    { ai_provider_id: facadeId, model: args.alias }
  );
  const endpoint = args.aiProvider.aliasTargets[args.targetId];
  if (!endpoint) throw misconfigured;
  let model: LanguageModel;
  try {
    model = args.build({ endpoint, vendorModel: args.vendorModel });
  } catch {
    throw misconfigured;
  }
  if (typeof model === 'string') throw misconfigured;
  return wrapLanguageModel({
    model,
    middleware: [
      answeringAs(args.alias),
      faultingAs({ facadeId, alias: args.alias }),
    ],
    modelId: args.alias,
  });
};
