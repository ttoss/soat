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
  iam: ['iam_token', 'iam_principal'],
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

/** The SRN resource type of a check on the whole project, `srn:<project_id>:*:*`. */
export const WHOLE_PROJECT = '*';

/**
 * Built-in modules whose actions no typed SRN carries: the type `iam/check`
 * answers them on, `null` for none, and why.
 */
export const UNTYPED_BUILT_IN_MODULES: Readonly<
  Record<string, { checkedOn: typeof WHOLE_PROJECT | null; why: string }>
> = {
  'project-groups': {
    checkedOn: null,
    why: 'checked on the project group, srn:project-group:<project_group_id>:..., or an admin role gate',
  },
  projects: { checkedOn: WHOLE_PROJECT, why: 'checked on the whole project' },
  users: { checkedOn: null, why: 'an admin role gate, not a policy' },
};
