/**
 * The refusal of a model no price row covers, behind `require_priced_model`:
 * on the project it holds every binding, on an AI provider that provider's.
 *
 * A `cost_usd` quota and a guardrail cost ceiling both answer *after* the fact:
 * they read a window the meter already wrote, so the calls that opened an
 * unpriced window always ran, and a window holding one priced model beside an
 * unpriced one reads the priced spend alone (`costEnforceability.ts`). This
 * gate answers before the provider is called instead, on the binding itself —
 * the one question a window cannot ask: *may this model run at all*.
 *
 * It is opt-in because a deployment that keeps no price book meters every
 * event at `cost_usd = null` and must keep running; the provider flag lets one
 * project hold the providers it bills while its others run unpriced.
 *
 * Every language model a provider row serves is built here, so no caller
 * reaches a provider without crossing the gate
 * (`tests/harness/modelPricingChokepoint.test.mjs`). The check reads the
 * configured model, the name the binding can be held to before a call exists.
 * A provider that answers under a more specific id (a dated snapshot of the
 * model asked for) meters under that id, so the `quota_unpriced` exception
 * remains the backstop that names it.
 */

import type { LanguageModel } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import type { ModelProvider } from './aiProviderModelAliases';
import type { UnpricedRow } from './costEnforceability';
import { limitsFor, type ModelInputLimits } from './inputLimits';
import { declaredFor, type ModelInputModalities } from './inputModalityGate';
import { withInputBoundary } from './modelInputBoundary';
import { getEffectivePrice } from './priceBook';

const log = createDebug('soat:model-pricing-gate');

/**
 * The components every token event bills. The two cache dimensions are left
 * out because an unpriced one falls back to the `input_tokens` rate rather than
 * metering at null (`usageTokenEvent.ts`), and `reasoning_tokens` is a
 * non-billable detail. Read per component, not per model: a model priced for
 * input and not output produces an event carrying a real cost that understates
 * itself.
 */
const GATED_COMPONENTS = ['input_tokens', 'output_tokens'];

/** A provider row as `resolveAiProviderSecret` returns it. */
export type PricedModelProvider = ModelProvider & {
  id: number;
  projectId: number;
  provider: string;
  requirePricedModel: boolean;
  /** What each model accepts; the input gate reads it off the built model. */
  modelInputModalities: ModelInputModalities;
  /** What each model declares it reads per request; the boundary enforces it. */
  modelInputLimits: ModelInputLimits;
};

/** A `(provider, model)` pair a call may bill against. */
export type ModelBinding = {
  aiProvider: PricedModelProvider;
  /** The string the meter reads, so the gate and the meter name one model. */
  model: string;
};

/**
 * The `(provider, model, component)` rows no price covers, resolved through the
 * same tiering the meter prices with, in the price book of the project that
 * reaches the provider, so a per-provider override or a project rate satisfies
 * the gate exactly where it would satisfy the cost.
 */
const unpricedRows = async (
  bindings: ModelBinding[]
): Promise<UnpricedRow[]> => {
  const at = new Date();
  const rows: UnpricedRow[] = [];

  for (const { aiProvider, model } of bindings) {
    for (const component of GATED_COMPONENTS) {
      const price = await getEffectivePrice({
        provider: aiProvider.provider,
        model,
        component,
        aiProviderId: aiProvider.id,
        projectId: aiProvider.grantee ?? aiProvider.projectId,
        at,
      });
      if (!price) {
        rows.push({ provider: aiProvider.provider, model, component });
      }
    }
  }

  return rows;
};

/**
 * An unreadable price book refuses rather than waving the call through: the
 * same database has to be readable for the call to be metered at all.
 */
const assertBindingsPriced = async (args: {
  spendProjectId: number;
  bindings: ModelBinding[];
}): Promise<void> => {
  const project = await db.Project.findByPk(args.spendProjectId, {
    attributes: ['requirePricedModel'],
  });
  const projectRequires = project?.requirePricedModel === true;
  const held = args.bindings.filter((binding) => {
    return projectRequires || binding.aiProvider.requirePricedModel;
  });
  if (held.length === 0) return;

  const rows = await unpricedRows(held);
  if (rows.length === 0) return;

  log(
    'assertBindingsPriced: spendProjectId=%d refused %o',
    args.spendProjectId,
    rows
  );
  const named = rows
    .map((row) => {
      return `${row.provider}/${row.model} ${row.component}`;
    })
    .join(', ');

  throw new DomainError(
    'MODEL_NOT_PRICED',
    `A priced model is required, and no price row covers ${named}.`,
    { unpriced_rows: rows }
  );
};

/**
 * Builds each binding's language model once all of them pass the gate: a
 * route's targets are checked together, because a failover bills whichever
 * target answers. `spendProjectId` is the project the call's spend is metered
 * against, which for a shared agent is the project the turn runs in.
 */
export const buildPricedModels = async (args: {
  spendProjectId: number;
  bindings: ModelBinding[];
}): Promise<LanguageModel[]> => {
  await assertBindingsPriced(args);
  return args.bindings.map((binding) => {
    return withInputBoundary({
      model: buildModel(binding),
      modelName: binding.model,
      accepted: declaredFor({
        modelInputModalities: binding.aiProvider.modelInputModalities,
        model: binding.model,
      }),
      limits: limitsFor({
        modelInputLimits: binding.aiProvider.modelInputLimits,
        model: binding.model,
      }),
      projectId: args.spendProjectId,
    });
  });
};

export const buildPricedModel = async (args: {
  spendProjectId: number;
  aiProvider: PricedModelProvider;
  model: string;
}): Promise<LanguageModel> => {
  const [model] = await buildPricedModels({
    spendProjectId: args.spendProjectId,
    bindings: [{ aiProvider: args.aiProvider, model: args.model }],
  });
  return model;
};
