/**
 * The SRN type a public id authorizes on, keyed by the `x-soat-resource` kind
 * that names it. Each entry mirrors the `isAllowed` call its module's routes
 * make. A module whose item routes still authorize at project level has no
 * entry (`errorShapeContract.test.ts` fails such a route outright).
 */
const RESOURCE_TYPE_OF_KIND = new Map<string, string>([
  ['oauth_client', 'oauth_client'],
  ['oauth_connection', 'oauth_connection'],
  ['actor', 'actor'],
  ['agent', 'agent'],
  ['audit', 'audit'],
  ['chain', 'chain'],
  // Item operations name the collection: an item has no public id.
  ['collection', 'collection'],
  ['conversation', 'conversation'],
  ['dataset', 'dataset'],
  ['decider', 'decider'],
  ['decision', 'decision'],
  ['eval', 'eval'],
  ['generation', 'generation'],
  ['guardrail', 'guardrail'],
  // camelCase, unlike every other SRN type — renaming it is a public-contract
  // change of its own.
  ['ingestionRule', 'ingestionRule'],
  // A memory and a memory rule authorize through their store, as their routes do.
  ['memory', 'memory_store'],
  ['memory_rule', 'memory_store'],
  ['memory_store', 'memory_store'],
  ['metadata_schema', 'metadata_schema'],
  ['model_route', 'model_route'],
  ['orchestration', 'orchestration'],
  // A run authorizes through the orchestration it runs.
  ['orchestration_run', 'orchestration'],
  ['playbook', 'playbook'],
  ['playbook_case', 'playbook_case'],
  ['quota', 'quota'],
  ['session', 'session'],
  ['tool', 'tool'],
  ['trace', 'trace'],
  // A usage *threshold*, under the SRN type its route probes.
  ['usage', 'usage'],
]);

export const listResourceKinds = (): string[] => {
  return [...RESOURCE_TYPE_OF_KIND.keys()];
};

/** The SRN type a kind's id authorizes on; `undefined` for an unlisted kind. */
export const resourceTypeOfKind = (args: {
  kind: string;
}): string | undefined => {
  return RESOURCE_TYPE_OF_KIND.get(args.kind);
};
