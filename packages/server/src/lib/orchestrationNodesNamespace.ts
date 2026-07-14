import type { OrchestrationNode } from './orchestrations';

/**
 * Reserved top-level state key: every node's artifact is recorded here (see
 * {@link writeNodeArtifact}), giving orchestrations the same
 * read-any-upstream-result ergonomics as a pipeline's `steps.<id>` — without
 * requiring an explicit `state_mapping` write. Static
 * validation (`checkReservedNodeNamespace`) rejects a `state_mapping`
 * write that targets this namespace, since the engine owns it exclusively.
 * (Run input cannot collide: it is seeded under `state.input` only, so even
 * an input property named `nodes` lands at `state.input.nodes`.)
 *
 * Deliberately a standalone leaf module (only a type-only import from
 * `orchestrations.ts`): both `orchestrationNodeExecutors.ts` and
 * `orchestrationValidation.ts` need this constant and neither may import the
 * other's module graph without creating a cycle
 * (`orchestrationNodeExecutors.ts` -> `orchestrationEngine.ts` ->
 * `orchestrations.ts` -> `orchestrationValidation.ts`).
 */
export const NODE_ARTIFACTS_STATE_KEY = 'nodes';

/**
 * Records a completed node's full artifact at `state.nodes.<nodeId>`, in
 * addition to whatever `state_mapping` projects into other
 * state paths. A downstream node reads it with
 * `{ "var": "nodes.<nodeId>.<field>" }`.
 *
 * The artifact is deep-cloned before storage. A `transform`/`condition`
 * node's expression may reflect the whole state back as its result (e.g.
 * `{ "var": "" }`), which makes `artifact` alias `state` itself; nesting that
 * live reference into `state.nodes.<nodeId>` would make `state` contain
 * itself, a cycle that crashes JSON serialization (the run's HTTP response
 * and its JSONB checkpoint alike). Cloning snapshots the artifact as it stood
 * at completion time, matching how it is independently persisted anyway.
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
