import type { LanguageModel } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { readRoutingMetadata } from './modelRouteExecutor';

const log = createDebug('soat:model-routes');

/**
 * Stamps what the route actually did onto the generation's `metadata.routing`:
 * `{ route_id, target_index, attempts: [{ target_index, ai_provider_id, model,
 * error_class? }], fallbacks }`. A trace can then explain which provider
 * answered, and a failed attempt that burned tokens is at least *visible* even
 * though the provider's error carried no usage to meter.
 *
 * No-ops for a non-routed model, so every completion path can call it
 * unconditionally. Merges rather than replaces: `metadata.pendingState` for a
 * paused client-tool generation lives in the same column.
 */
export const saveRoutingMetadata = async (args: {
  generationId: string;
  model: LanguageModel | undefined;
}): Promise<void> => {
  if (!args.model) return;
  const routing = readRoutingMetadata(args.model);
  if (!routing) return;

  const generation = await db.Generation.findOne({
    where: { publicId: args.generationId },
  });
  // The record is created before the generation runs, so every caller here
  // names a row that exists.
  /* istanbul ignore next */
  if (!generation) return;

  const metadata = (generation.metadata ?? {}) as Record<string, unknown>;

  await generation.update({
    metadata: {
      ...metadata,
      routing: {
        route_id: routing.route_id,
        target_index: routing.target_index,
        // Snapshot: the composite keeps appending for the life of the run.
        attempts: [...routing.attempts],
        fallbacks: routing.fallbacks,
      },
    },
  });

  log(
    'saveRoutingMetadata: generationId=%s route=%s target=%s fallbacks=%d',
    args.generationId,
    routing.route_id,
    routing.target_index,
    routing.fallbacks
  );
};
