import type { OrchestrationNode } from './orchestrations';

/**
 * Reserved top-level state key: every node's artifact is recorded here (see
 * {@link writeNodeArtifact}), giving the read-any-upstream-result ergonomics of
 * a pipeline's `steps.<id>` with no explicit `state_mapping` write.
 * `checkReservedNodeNamespace` rejects a `state_mapping` write targeting it.
 * Run input cannot collide: it is seeded under `state.input` only.
 *
 * A standalone leaf module because both `orchestrationNodeExecutors.ts` and
 * `orchestrationValidation.ts` need the constant and neither may import the
 * other's module graph without creating a cycle.
 */
export const NODE_ARTIFACTS_STATE_KEY = 'nodes';

/**
 * Records a completed node's full artifact at `state.nodes.<nodeId>`, alongside
 * whatever `state_mapping` projects elsewhere. A downstream node reads it with
 * `{ "var": "nodes.<nodeId>.<field>" }`.
 *
 * Deep-cloned before storage: a `transform`/`condition` expression may reflect
 * the whole state back as its result (`{ "var": "" }`), which makes `artifact`
 * alias `state`, and nesting that live reference would make `state` contain
 * itself — a cycle that crashes JSON serialization of both the HTTP response
 * and the JSONB checkpoint.
 */
export const writeNodeArtifact = (args: {
  nodeId: string;
  artifact: Record<string, unknown>;
  state: Record<string, unknown>;
}): void => {
  const { nodeId, artifact, state } = args;
  const existing = state[NODE_ARTIFACTS_STATE_KEY];
  const nodes: Record<string, unknown> =
    existing !== null &&
    typeof existing === 'object' &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  state[NODE_ARTIFACTS_STATE_KEY] = {
    ...nodes,
    [nodeId]: structuredClone(artifact),
  };
};

const topSegment = (path: string): string => {
  return path.split('.')[0] as string;
};

/**
 * `nodes` is a reserved top-level state key: the engine writes every
 * completed node's artifact to `state.nodes.<nodeId>` unconditionally (see
 * {@link writeNodeArtifact}), so a `state_mapping` write targeting it would
 * silently fight the engine for ownership. Checked against every node's
 * write paths (a `state_mapping`'s own keys are its write destinations).
 * Run input is deliberately not checked: it is seeded under `state.input`
 * only, so an input property named `nodes` can never reach `state.nodes`.
 */
export const checkReservedNodeNamespace = (args: {
  nodes: OrchestrationNode[];
}): Array<{ path: string; message: string }> => {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [index, node] of args.nodes.entries()) {
    if (!node.stateMapping) continue;
    for (const statePath of Object.keys(node.stateMapping)) {
      const normalizedPath = statePath.startsWith('state.')
        ? statePath
        : `state.${statePath}`;
      const remainder = normalizedPath.slice('state.'.length);
      if (topSegment(remainder) === NODE_ARTIFACTS_STATE_KEY) {
        issues.push({
          path: `nodes[${index}].state_mapping.${statePath}`,
          message:
            "writes to the reserved 'nodes' state namespace, which the engine owns exclusively for per-node artifacts (state.nodes.<nodeId>).",
        });
      }
    }
  }
  return issues;
};
