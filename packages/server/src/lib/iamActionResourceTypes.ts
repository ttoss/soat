/**
 * The SRN resource types each built-in module's routes authorize its actions
 * on, keyed by the action's module prefix. `POST /api/v1/iam/check` refuses a
 * built-in action on any other type. Held to the routes by
 * `tests/unit/tests/lib/iamActionResourceTypes.test.ts`.
 */
export const BUILT_IN_ACTION_RESOURCE_TYPES: Readonly<
  Record<string, readonly string[]>
> = {
  activity: ['activity'],
  actors: ['actor'],
  agents: ['agent', 'session'],
  'ai-providers': ['aiProvider'],
  'api-keys': ['apiKey'],
  approvals: ['approval'],
  audit: ['audit'],
  chains: ['chain'],
  chats: ['chat'],
  collections: ['collection', 'collection_item'],
  conversations: ['conversation'],
  deciders: ['decider', 'decision'],
  documents: ['document'],
  embeddings: ['embedding'],
  evaluations: ['eval', 'dataset'],
  exceptions: ['exception'],
  files: ['file'],
  formations: ['formation'],
  generations: ['generation'],
  guardrails: ['guardrail'],
  iam: ['iam_token'],
  'ingestion-rules': ['ingestionRule'],
  knowledge: ['document', 'memory_store', 'memory'],
  memories: ['memory', 'memory_store'],
  'metadata-schemas': ['metadata_schema'],
  'model-routes': ['model_route'],
  'oauth-clients': ['oauth_client'],
  'oauth-connections': ['oauth_connection'],
  orchestrations: ['orchestration'],
  playbooks: ['playbook', 'playbook_case'],
  policies: ['policy'],
  quotas: ['quota'],
  secrets: ['secret'],
  shares: ['share'],
  tasks: ['task'],
  tools: ['tool'],
  traces: ['trace'],
  triggers: ['trigger', 'triggerFiring'],
  usage: ['usage'],
  webhooks: ['webhook'],
  workflows: ['workflow'],
};

/** Built-in modules whose actions no typed SRN carries, with why. */
export const UNTYPED_BUILT_IN_MODULES: Readonly<Record<string, string>> = {
  projects: 'checked on the whole project, srn:<project_id>:*:*',
  users: 'an admin role gate, not a policy',
};
