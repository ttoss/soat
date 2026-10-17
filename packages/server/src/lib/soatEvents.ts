/**
 * The registry of platform events, keyed by the resource type each belongs to.
 *
 * The single source of truth for three things that must agree: the union
 * `emitResourceEvent` accepts, the set a subscriber may declare interest in,
 * and the webhooks documentation table (generated from here by
 * `packages/website/scripts/generateWebhookEventsPage.ts`).
 *
 * As bare `string`s, a renamed or misspelled event would compile fine and
 * simply never match — a webhook subscription would stop delivering with
 * nothing failing. Pairing the name with its resource type makes that a type
 * error at the emit site. The description
 * lives in the entry because the generated reference reads it: a new event is
 * documented by the same edit that registers it.
 *
 * Every name is `<resource type, plural>.<verb>`, so a `<plural>.*` pattern is
 * exactly one resource type's events (pinned by `eventTypeContract.test.ts`).
 *
 * **This file deliberately imports nothing** — the website's docs generator
 * loads it, so a runtime import would drag the DB layer into a docs build.
 *
 * The event `data` payload is not typed here: it is the record the resource's
 * `GET` answers, and a description names only the facts an event carries
 * beside it. Nothing on the bus reads a key of it, so nothing on the bus needs
 * its shape: type the envelope, keep the payload a value.
 */
export const SOAT_EVENTS = {
  agent: {
    'agents.created': 'An agent was created.',
    'agents.updated': 'An agent was updated.',
    'agents.deleted': 'An agent was deleted.',
  },
  approval: {
    'approvals.created': 'An approval request was raised and is pending.',
    'approvals.approved': 'A pending approval was approved.',
    'approvals.rejected': 'A pending approval was rejected.',
    'approvals.expired': 'A pending approval passed its deadline unanswered.',
  },
  audit: {
    'audit_entries.created': 'An audit entry was recorded.',
  },
  conversation: {
    'conversations.created': 'A conversation was created.',
    'conversations.updated': 'A conversation was updated.',
    'conversations.deleted': 'A conversation was deleted.',
  },
  conversation_message: {
    'conversation_messages.created':
      'A message was added to a conversation; the payload carries the message plus its `conversation_id`.',
    'conversation_messages.generated':
      'An assistant message was generated in a conversation; the payload carries the message plus `conversation_id`, `generation_id` and `trace_id`.',
    'conversation_messages.deleted':
      'A message was removed from a conversation; the payload carries the message as it stood plus its `conversation_id`.',
  },
  decision: {
    'decisions.completed':
      'A decision settled with its answers; the payload carries the decision, answers included.',
    'decisions.failed':
      'A decision settled without answers; the payload carries the decision and its `error`.',
  },
  document: {
    'documents.created': 'A document was created.',
    'documents.updated': 'A document was updated.',
    'documents.deleted': 'A document was deleted.',
    'documents.withdrawn':
      'A document was withdrawn: it leaves listings and knowledge search, its chunks are dropped from the index, and the withdrawal is recorded as a version. It stays readable by id and can be restored.',
    'documents.restored':
      'A withdrawn document was restored from an earlier version: its content is re-chunked and re-indexed, and it returns to listings and knowledge search.',
    'documents.ingested':
      'A document finished ingestion and is indexed (`status=ready`); the payload carries the document plus its final `chunk_count`.',
    'documents.ingest_failed':
      'A document ingestion settled in failure (`status=failed`); the payload carries the document plus the `error` reason (e.g. `FILE_PARSE_FAILED`, `INGESTION_TIMEOUT`).',
  },
  eval_run: {
    'eval_runs.completed':
      'An eval run reached a terminal status with its items scored; the payload is the run, carrying the pass/fail verdict consumed by eval-gated promotion.',
    'eval_runs.failed':
      'An eval run could not be executed to completion (infrastructure failure).',
  },
  exception: {
    'exceptions.created': 'An exception was filed.',
  },
  file: {
    'files.created': 'A file was uploaded.',
    'files.updated': 'A file was updated.',
    'files.deleted': 'A file was deleted.',
  },
  generation: {
    'generations.requires_action':
      'A generation paused for a client-side tool result; the payload carries the generation plus the pending `required_action`.',
    'generations.completed':
      'A generation completed; a turn run in a session carries its `session_id`.',
    'generations.failed': 'A generation failed.',
    'generations.content_purged':
      "A generation's content was redacted, leaving its auditable skeleton.",
    'generations.chain_limit':
      'A continuation chain reached its generation budget and was refused; the payload carries the root generation plus `chain_size`, `limit`, `limit_source`, `refused_agent_id` and `refused_initiator_generation_id`.',
  },
  guardrail: {
    'guardrails.tripwire':
      'A guardrail tripwire aborted a tool call; the payload carries the guardrail plus `guardrail_version` and the aborted call (`tool_id`, `tool_name`, `action`, `agent_id`, `generation_id`, `orchestration_run_id`, `node_id`).',
  },
  memory: {
    'memories.retracted':
      'A memory was retracted: the fact stopped holding with nothing replacing it, so it leaves knowledge search, dedup and the default listing. It stays readable by id, with its assertions.',
  },
  orchestration_run: {
    'orchestration_runs.started': 'An orchestration run started.',
    'orchestration_runs.awaiting_input':
      'An orchestration run paused waiting for input.',
    'orchestration_runs.completed': 'An orchestration run completed.',
    'orchestration_runs.failed': 'An orchestration run failed.',
  },
  project: {
    'projects.paused':
      'A project was paused: nothing new starts in it, and the runs and tasks it had in motion park at their next checkpoint.',
    'projects.resumed':
      'A project was resumed: the runs and tasks its pause held are handed back, and its schedules fire again.',
  },
  quota: {
    'quotas.exceeded':
      'A quota limit was exceeded; the payload carries the quota plus the breached `window_key` and the `observed_value`.',
  },
  session: {
    'sessions.created': 'A session was created.',
    'sessions.updated': 'A session was updated.',
    'sessions.deleted': 'A session was deleted.',
    'sessions.generation_started':
      'A generation started in a session; the payload is the session, before the generation is created. The turn settles as a `generations.*` event.',
  },
  task: {
    'tasks.created': 'A task was created.',
    'tasks.transitioned':
      'A task moved to a new state; the payload carries the task plus `transition` and `from_state`.',
    'tasks.closed': 'A task reached a terminal state.',
    'tasks.stalled': 'A task exceeded its stall threshold without progress.',
    'tasks.paused': "A task's automation was paused by an operator.",
    'tasks.resumed': "A task's automation was resumed.",
    'tasks.approval_failed':
      "A task's approved transition could no longer apply; the payload carries the task plus `transition` and `error_code`.",
    'tasks.automation_retrying':
      "A task's automation is being retried; the payload carries the task plus `attempt`, `max_attempts`, `error`, `generation_id` and `orchestration_run_id`.",
    'tasks.automation_rejected':
      "A task's automation rejected the task; the payload carries the task plus `result`, `transition` and `error_code`.",
    'tasks.automation_unrouted':
      'A task matched no automation route; the payload carries the task plus `result`.',
  },
  trace: {
    'traces.content_purged':
      "A trace's content was redacted, leaving its auditable skeleton.",
  },
  usage_threshold: {
    'usage_thresholds.crossed': 'A usage threshold was crossed.',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The resource types the bus can carry an event for. */
export type SoatResourceType = keyof typeof SOAT_EVENTS;

/**
 * Resource type -> the event names registered for it. Both public aliases index
 * this one map so the compiler relates them: `EventTypesByResource[R]` is
 * assignable to `EventTypesByResource[SoatResourceType]`, which is what lets a
 * generic emit helper pass its narrowed name to a function taking any event
 * name.
 */
type EventTypesByResource = {
  [R in SoatResourceType]: keyof (typeof SOAT_EVENTS)[R] & string;
};

/** The event names registered for one resource type. */
export type SoatEventTypeFor<R extends SoatResourceType> =
  EventTypesByResource[R];

/**
 * Every event name the platform itself emits. Indexed by the union of resource
 * types rather than written as `keyof SOAT_EVENTS[SoatResourceType]`, which
 * yields the keys *common* to every entry — `never`.
 */
export type SoatEventType = EventTypesByResource[SoatResourceType];

/**
 * A user-authored event name, produced only by an orchestration `emit_event`
 * node. Branded so it cannot be confused with a registered name: a platform
 * emit site cannot reach this type by writing a string literal, it has to go
 * through `emitCustomEvent`.
 */
declare const customEventBrand: unique symbol;
export type CustomEventName = string & { readonly [customEventBrand]: never };

/** The `type` an envelope on the bus can carry. */
export type SoatEventName = SoatEventType | CustomEventName;

/**
 * Every registered event name, flattened. The assertion is `Object.keys`
 * widening its result to `string[]`; the values are the registry's own keys, so
 * the narrower type is the true one.
 */
export const SOAT_EVENT_TYPES: readonly SoatEventType[] = Object.values(
  SOAT_EVENTS
).flatMap((events) => {
  return Object.keys(events) as SoatEventType[];
});

const REGISTERED = new Set<string>(SOAT_EVENT_TYPES);

/** Narrows an arbitrary string to a registered platform event name. */
export const isSoatEventType = (value: string): value is SoatEventType => {
  return REGISTERED.has(value);
};

/**
 * Marks a user-authored name as a custom event. The only producer is
 * `emitCustomEvent`; a `lib/eventTypeContract.test.ts` check keeps it that way.
 */
export const asCustomEventName = (args: { name: string }): CustomEventName => {
  return args.name as CustomEventName;
};
