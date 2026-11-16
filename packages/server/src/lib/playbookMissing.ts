import type { JsonSchema, PlaybookDefinition } from './playbookDefinition';
import { nodesByKey, topologicalWaves, upstreamOf } from './playbookGraph';
import type { PlaybookNodeView } from './playbookState';

export type PlaybookMissingInput = {
  node_id: string;
  input: string;
  schema: JsonSchema;
  description?: string;
  required: boolean;
};

/**
 * The manual inputs still unset or refused upstream of `node`, grouped by the
 * wave of the node that holds them. Optional ones are listed too, since an
 * agent asks for exactly what this lists; `required` says which ones block.
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
          const node = byKey.get(key);
          const view = views.get(key);
          if (!node || !view) return [];

          return node.inputs
            .filter((input) => {
              return (
                input.source === 'manual' &&
                !Object.hasOwn(view.values, input.name)
              );
            })
            .map((input) => {
              return {
                node_id: key,
                input: input.name,
                schema: input.schema,
                ...(input.description !== undefined && {
                  description: input.description,
                }),
                required: view.resolvedRequired[input.name],
              };
            });
        });
    })
    .filter((wave) => {
      return wave.length > 0;
    });
};
