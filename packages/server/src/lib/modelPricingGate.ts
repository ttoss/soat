/**
 * The project-scoped refusal of a model no price row covers, behind
 * `require_priced_model`.
 *
 * A `cost_usd` quota and a guardrail cost ceiling both answer *after* the fact:
 * they read a window the meter already wrote, so the generations that opened an
 * unpriced window always ran, and a window holding one priced model beside an
 * unpriced one reads the priced spend alone (`costEnforceability.ts`). This
 * gate answers before the provider is called instead, on the binding itself —
 * the one question a window cannot ask: *may this model run at all*.
 *
 * It is opt-in because a deployment that keeps no price book meters every
 * event at `cost_usd = null` and must keep running.
 *
 * The check reads the configured model, which is the name the binding can be
 * held to before a call exists. A provider that answers under a more specific
 * id (a dated snapshot of the model asked for) meters under that id, so the
 * `quota_unpriced` exception remains the backstop that names it.
 */

import { db } from '../db';
import { DomainError } from '../errors';
import type { TypedAgent } from './agentGenerationTypes';
import type { UnpricedRow } from './costEnforceability';
import { resolveConsumerModelRoute } from './modelRouteDefaults';
import { getEffectivePrice } from './priceBook';

/**
 * The components every token event bills. The two cache dimensions are left
 * out because an unpriced one falls back to the `input_tokens` rate rather than
 * metering at null (`usageTokenEvent.ts`), and `reasoning_tokens` is a
 * non-billable detail. Read per component, not per model: a model priced for
 * input and not output produces an event carrying a real cost that understates
 * itself.
 */
const GATED_COMPONENTS = ['input_tokens', 'output_tokens'];

/** A `(provider, model)` pair a turn may bill against, and the instance serving it. */
type ModelCandidate = {
  provider: string;
  model: string;
  aiProviderId: number;
};

type CandidateBinding = {
  aiProviderPublicId: string | undefined;
  model: string | null;
};

/**
 * What the turn may spend on: a routed agent's whole target list, because a
 * failover bills whichever target answers, and a pinned agent's single pair.
 *
 * The route and the provider rows are read again here rather than carried out
 * of `resolveAgentModel`: two reads on a project that opted into the gate cost
 * nothing beside the provider call they precede, and threading the pair through
 * the routing stack would put a pricing concern in every model builder.
 */
const resolveCandidates = async (
  typedAgent: TypedAgent
): Promise<ModelCandidate[]> => {
  const projectId = typedAgent.project.id as number;
  const route = await resolveConsumerModelRoute({
    projectId,
    modelRouteId: typedAgent.modelRoute?.publicId,
    aiProviderId: typedAgent.aiProvider?.publicId,
  });

  const bindings: CandidateBinding[] = route
    ? route.targets.map((target) => {
        return {
          aiProviderPublicId: target.ai_provider_id,
          model: target.model,
        };
      })
    : [
        {
          aiProviderPublicId: typedAgent.aiProvider?.publicId,
          model: typedAgent.model,
        },
      ];

  const providers = await db.AiProvider.findAll({
    where: {
      publicId: bindings.map((binding) => {
        return binding.aiProviderPublicId ?? '';
      }),
      projectId,
    },
    attributes: ['id', 'publicId', 'provider', 'defaultModel'],
  });

  return bindings.flatMap((binding) => {
    const provider = providers.find((row) => {
      return row.publicId === binding.aiProviderPublicId;
    });
    if (!provider) return [];
    return [
      {
        provider: provider.provider,
        // The same string `buildModel` is given, so the gate and the meter
        // read one name.
        model: binding.model ?? provider.defaultModel ?? '',
        aiProviderId: provider.id as number,
      },
    ];
  });
};

/**
 * The `(provider, model, component)` rows no price covers, resolved through the
 * same tiering the meter prices with, so a per-provider override or a project
 * rate satisfies the gate exactly where it would satisfy the cost.
 */
const unpricedRows = async (args: {
  projectId: number;
  candidates: ModelCandidate[];
}): Promise<UnpricedRow[]> => {
  const at = new Date();
  const rows: UnpricedRow[] = [];

  for (const candidate of args.candidates) {
    for (const component of GATED_COMPONENTS) {
      const price = await getEffectivePrice({
        provider: candidate.provider,
        model: candidate.model,
        component,
        aiProviderId: candidate.aiProviderId,
        projectId: args.projectId,
        at,
      });
      if (!price) {
        rows.push({
          provider: candidate.provider,
          model: candidate.model,
          component,
        });
      }
    }
  }

  return rows;
};

/**
 * Refuses a fresh turn whose model carries no price, on a project that requires
 * one. Raised before the generation record exists and before any context is
 * built, so a refusal leaves nothing recorded and nothing metered.
 *
 * An unreadable price book refuses rather than waving the turn through: the
 * same database has to be readable for the turn to be recorded at all, so a
 * read that fails here is not a case worth staying available for.
 */
export const assertGenerationModelPriced = async (args: {
  typedAgent: TypedAgent;
}): Promise<void> => {
  if (args.typedAgent.project.requirePricedModel !== true) return;

  const projectId = args.typedAgent.project.id as number;
  const rows = await unpricedRows({
    projectId,
    candidates: await resolveCandidates(args.typedAgent),
  });
  if (rows.length === 0) return;

  const named = rows
    .map((row) => {
      return `${row.provider}/${row.model} ${row.component}`;
    })
    .join(', ');

  throw new DomainError(
    'MODEL_NOT_PRICED',
    `Project '${args.typedAgent.project.publicId}' requires a priced model, and no price row covers ${named}.`,
    { unpriced_rows: rows }
  );
};
