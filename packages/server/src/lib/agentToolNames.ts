import type { Tool } from 'ai';

/** What one binding contributed to the turn, keyed as it resolved them. */
export type BindingTools = {
  bindingName: string;
  tools: Record<string, Tool>;
};

const freeName = (args: { candidate: string; taken: Set<string> }): string => {
  let name = args.candidate;
  for (let ordinal = 2; args.taken.has(name); ordinal += 1) {
    name = `${args.candidate}_${ordinal}`;
  }
  return name;
};

/**
 * The model-facing tool set of a turn. A key only one binding resolves keeps its
 * name; a key several bindings resolve is offered once per binding as
 * `<binding name>_<key>`, so no binding's tool (and its presets) replaces
 * another's. Gating and activity are bound per binding before this runs.
 */
export const mergeBindingTools = (args: {
  bindings: BindingTools[];
}): Record<string, Tool> => {
  const occurrences = new Map<string, number>();
  for (const binding of args.bindings) {
    for (const key of Object.keys(binding.tools)) {
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  }
  const taken = new Set(
    [...occurrences].flatMap(([key, count]) => {
      return count === 1 ? [key] : [];
    })
  );

  const merged: Record<string, Tool> = {};
  for (const binding of args.bindings) {
    for (const [key, resolved] of Object.entries(binding.tools)) {
      if (occurrences.get(key) === 1) {
        merged[key] = resolved;
        continue;
      }
      const name = freeName({
        candidate: `${binding.bindingName}_${key}`,
        taken,
      });
      taken.add(name);
      merged[name] = resolved;
    }
  }
  return merged;
};
