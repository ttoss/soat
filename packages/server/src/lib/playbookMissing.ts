import type { JsonSchema, PlaybookDefinition } from './playbookDefinition';
import { nodesByKey, topologicalWaves, upstreamOf } from './playbookGraph';
import type { PlaybookNodeView } from './playbookState';

export type PlaybookMissingInput = {
  node_id: string;
  input: string;
  schema: JsonSchema;
  description?: string;
};

/**
 * The manual inputs a person still has to fill before `node` can be reached,
 * grouped by the wave of the node that holds them.
 */
export const playbookMissingInputs = (args: {
  definition: PlaybookDefinition;
  views: Map<string, PlaybookNodeView>;
  node: string;
}): PlaybookMissingInput[][] => {
  const { definition, views } = args;

  const upstream = upstreamOf(args);
  const byKey = nodesByKey({ definition });

  return topologicalWaves({ definition })
    .waves.map((wave) => {
      return wave
        .filter((key) => {
          return upstream.has(key);
        })
        .flatMap((key) => {
          const missing = new Set(views.get(key)?.missing);

          return (byKey.get(key)?.inputs ?? [])
            .filter((input) => {
              return input.source === 'manual' && missing.has(input.name);
            })
            .map((input) => {
              return {
                node_id: key,
                input: input.name,
                schema: input.schema,
                ...(input.description !== undefined && {
                  description: input.description,
                }),
              };
            });
        });
    })
    .filter((wave) => {
      return wave.length > 0;
    });
};
