import type { LanguageModel } from 'ai';

import { DomainError } from '../errors';
import { INPUT_MODALITIES, type InputModality } from './inputModalities';

/** Model name → the input modalities it accepts, as an AI provider declares. */
export type ModelInputModalities = Record<string, InputModality[]>;

const isInputModality = (value: unknown): value is InputModality => {
  return INPUT_MODALITIES.some((modality) => {
    return modality === value;
  });
};

/**
 * Refuses a declaration the gate could not read. Formations write it without
 * the REST schema, so the shape is checked here, where every writer passes.
 */
export const assertModelInputModalities = (value: unknown): void => {
  if (value === undefined || value === null) return;
  const invalid =
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(([model, modalities]) => {
      return (
        model === '' ||
        !Array.isArray(modalities) ||
        !modalities.every(isInputModality)
      );
    });
  if (!invalid) return;
  throw new DomainError(
    'VALIDATION_FAILED',
    `model_input_modalities maps a model name to a list of: ${INPUT_MODALITIES.join(', ')}.`
  );
};

/** A stored declaration as the gate reads it: a value it cannot read declares nothing. */
export const readModelInputModalities = (
  stored: Record<string, unknown> | null | undefined
): ModelInputModalities => {
  const declared: ModelInputModalities = {};
  for (const [model, modalities] of Object.entries(stored ?? {})) {
    if (Array.isArray(modalities) && modalities.every(isInputModality)) {
      declared[model] = modalities;
    }
  }
  return declared;
};

/** The modalities of `required` a model cannot read; empty when it reads them all. */
type MissingModalities = (
  required: readonly InputModality[]
) => InputModality[];

/**
 * Each built model's answer, kept off the model object, as a route's routing
 * record is, so the SDK never reads it. A model nothing registered reads all.
 */
const gateByModel = new WeakMap<object, MissingModalities>();

export const registerInputGate = (args: {
  model: LanguageModel;
  missing: MissingModalities;
}): void => {
  if (typeof args.model !== 'object') return;
  gateByModel.set(args.model, args.missing);
};

export const missingInputModalities = (args: {
  model: LanguageModel;
  required: readonly InputModality[];
}): InputModality[] => {
  if (typeof args.model !== 'object') return [];
  return gateByModel.get(args.model)?.(args.required) ?? [];
};

/** The declaration for `model` on a provider, `null` when it names none. */
export const declaredFor = (args: {
  modelInputModalities: ModelInputModalities | null | undefined;
  model: string;
}): InputModality[] | null => {
  return args.modelInputModalities?.[args.model] ?? null;
};

/** The modalities `required` holds that `accepted` lacks; none when undeclared. */
export const missingModalities = (args: {
  accepted: readonly InputModality[] | null;
  required: readonly InputModality[];
}): InputModality[] => {
  const { accepted } = args;
  if (accepted === null) return [];
  return args.required.filter((modality) => {
    return !accepted.includes(modality);
  });
};

export const inputModalityRefusal = (args: {
  model: string;
  missing: readonly InputModality[];
}): DomainError => {
  return new DomainError(
    'INPUT_MODALITY_UNSUPPORTED',
    `Model '${args.model}' does not accept ${args.missing.join(', ')} input.`,
    { model: args.model, modalities: [...args.missing] }
  );
};

/**
 * Refuses, before the provider is called, input a model declares it cannot
 * read. A model that declares nothing is sent the input as it is.
 */
export const assertModelAcceptsInput = (args: {
  model: LanguageModel;
  required: readonly InputModality[];
}): void => {
  const missing = missingInputModalities(args);
  if (missing.length === 0) return;
  throw inputModalityRefusal({
    model: typeof args.model === 'string' ? args.model : args.model.modelId,
    missing,
  });
};
