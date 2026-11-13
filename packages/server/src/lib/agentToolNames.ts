import type { Tool } from 'ai';

import {
  gateResolvedToolsWithGuardrails,
  type ResolverGuardrailContext,
} from './agentToolGuardrail';
import type { CollectedGuardrail } from './guardrailCollection';

/**
 * What the guardrail gate needs to know about one binding. Required on every
 * binding, so a tool cannot join the turn without saying how it is gated.
 */
export type BindingGate = {
  /** The id a held call is proposed under; null for an inline tool. */
  toolId: string | null;
  toolType: string;
  toolName: string;
  /**
   * The binding's own tool-scope guardrails. The project and agent ones are
   * added by {@link gateAndMergeBindings} for every binding, never by it.
   */
  toolGuardrails: CollectedGuardrail[];
  presetParameters?: Record<string, unknown> | null;
  rawParameters?: Record<string, unknown>;
};

/** What one binding contributed to the turn, keyed as it resolved them. */
export type ToolBinding = {
  bindingName: string;
  tools: Record<string, Tool>;
  gate: BindingGate;
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
 * another's.
 */
const mergeBindingTools = (args: {
  bindings: Array<{ bindingName: string; tools: Record<string, Tool> }>;
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

/**
 * The only way a turn's bindings become its tool set: every binding passes the
 * guardrail gate under the project and agent guardrails plus its own.
 */
export const gateAndMergeBindings = (args: {
  bindings: ToolBinding[];
  guardrail: ResolverGuardrailContext;
}): Record<string, Tool> => {
  return mergeBindingTools({
    bindings: args.bindings.map(({ bindingName, tools, gate }) => {
      return {
        bindingName,
        tools: gateResolvedToolsWithGuardrails({
          tools,
          toolId: gate.toolId,
          toolType: gate.toolType,
          toolName: gate.toolName,
          guardrails: [
            ...args.guardrail.baseGuardrails,
            ...gate.toolGuardrails,
          ],
          presetParameters: gate.presetParameters,
          rawParameters: gate.rawParameters,
          context: args.guardrail,
        }),
      };
    }),
  });
};
