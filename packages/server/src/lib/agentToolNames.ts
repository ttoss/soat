import type { Tool } from 'ai';

import { resolvedActionName } from './agentToolApproval';
import {
  gateResolvedToolsWithGuardrails,
  type ResolverGuardrailContext,
} from './agentToolGuardrail';
import {
  countOf,
  type GenerationProvenance,
  type ProvenanceMetric,
  resultProvenance,
} from './generationProvenance';
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
  /** Whether a result of this binding enters the context as trusted content. */
  trustedOutput: boolean;
  presetParameters?: Record<string, unknown> | null;
  rawParameters?: Record<string, unknown>;
};

/** The counter a resolved tool's results feed; read off a client tool on submit. */
export const RESULT_PROVENANCE: unique symbol = Symbol('soat.resultProvenance');

export type ProvenancedTool = Tool & {
  [RESULT_PROVENANCE]?: ProvenanceMetric | null;
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
 * Marks each tool with the counter its results feed and counts every result
 * its `execute` returns. Inside the gate, so a held or refused call counts
 * nothing; a thrown result counts, since its error text enters the context too.
 */
const countEnteringResults = (args: {
  tools: Record<string, Tool>;
  gate: BindingGate;
  provenance: GenerationProvenance | null;
}): Record<string, Tool> => {
  return Object.fromEntries(
    Object.entries(args.tools).map(([key, resolved]) => {
      const metric = resultProvenance({
        toolType: args.gate.toolType,
        action: resolvedActionName({
          type: args.gate.toolType,
          toolName: args.gate.toolName,
          key,
        }),
        trustedOutput: args.gate.trustedOutput,
      });
      const marked: ProvenancedTool = {
        ...resolved,
        [RESULT_PROVENANCE]: metric,
      };
      const { execute } = resolved;
      const { provenance } = args;
      if (!execute || !provenance || !metric) return [key, marked];
      return [
        key,
        {
          ...marked,
          execute: async (...executeArgs: Parameters<typeof execute>) => {
            try {
              return await execute(...executeArgs);
            } finally {
              provenance.record(countOf(metric));
            }
          },
        },
      ];
    })
  );
};

/**
 * The only way a turn's bindings become its tool set: every binding passes the
 * guardrail gate under the project and agent guardrails plus its own, and
 * every result it returns is counted where it came from.
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
          tools: countEnteringResults({
            tools,
            gate,
            provenance: args.guardrail.provenance,
          }),
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
