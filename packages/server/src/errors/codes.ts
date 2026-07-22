/* eslint-disable max-lines */
export const ERROR_CODES = {
  RESOURCE_NOT_FOUND: {
    httpStatus: 404,
    description: 'The requested resource does not exist or is not accessible.',
  },
  AGENT_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced agent does not exist.',
  },
  ACTOR_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced actor does not exist.',
  },
  CHAT_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced chat does not exist.',
  },
  MEMORY_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced memory does not exist.',
  },
  AI_PROVIDER_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced AI provider does not exist.',
  },
  TOOL_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced tool does not exist.',
  },
  POLICY_NOT_FOUND: {
    httpStatus: 400,
    description: 'A referenced policy does not exist.',
  },
  AI_PROVIDER_ERROR: {
    httpStatus: 502,
    description:
      'The upstream AI provider returned an error (e.g. insufficient credits, rate limit, or the provider is unreachable).',
  },
  GENERATION_FAILED: {
    httpStatus: 500,
    description:
      'An unexpected error occurred during agent generation. Check the trace for details.',
  },
  GENERATION_NOT_FOUND: {
    httpStatus: 404,
    description:
      'The generation does not exist or is not in a pending state for tool output submission.',
  },
  SINGLE_SESSION_CONFLICT: {
    httpStatus: 409,
    description:
      'An open session already exists for this actor. Use the existing session or close it first.',
  },
  GENERATION_ALREADY_IN_PROGRESS: {
    httpStatus: 409,
    description:
      'A generation is already in progress for this session. Wait for it to complete before starting a new one.',
  },
  SESSION_EXPIRED: {
    httpStatus: 410,
    description:
      'The session has expired due to inactivity. Open a new session to continue.',
  },
  SESSION_CLOSED: {
    httpStatus: 409,
    description:
      'The session is closed and does not accept new messages or generation requests. Open a new session to continue.',
  },
  AGENT_AND_CHAT_EXCLUSIVE: {
    httpStatus: 400,
    description:
      'An actor cannot have both an agent_id and a chat_id assigned simultaneously. Set one or the other, not both.',
  },
  NAME_CONFLICT: {
    httpStatus: 409,
    description:
      'A resource with this name already exists in the project. Use a different name.',
  },
  SECRET_NOT_FOUND: {
    httpStatus: 400,
    description:
      'A secret referenced by a {{secret:...}} token does not exist in this project.',
  },
  INVALID_TEMPLATE_TOKEN: {
    httpStatus: 400,
    description:
      'A {{...}} double-curly token was found that is not a {{secret:sec_...}} reference. Double curly braces are reserved for secret references; use single braces ({param}) for URL path parameters.',
  },
  SECRET_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The secret is referenced by one or more AI providers and cannot be deleted. Use force=true to delete dependents as well.',
  },
  AI_PROVIDER_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The AI provider still has dependents. Live references (chats, agents, discussions) always block deletion and must be deleted or repointed first. Soft dependents (price overrides, usage records, discussion participants) block only until force=true, which drops the overrides and unlinks usage/participant history. The error meta reports the counts, a sample of offending IDs, and a `forcible` flag.',
  },
  AGENT_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The agent is referenced by one or more generations or traces and cannot be deleted. Delete the dependent records first.',
  },
  PROJECT_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The project has one or more dependent resources (agents, ai providers, tools, etc.) and cannot be deleted. Use force=true to delete dependents as well.',
  },
  FILE_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The file is referenced by one or more records and cannot be deleted. Delete the dependent records first.',
  },
  ACTOR_HAS_MESSAGES: {
    httpStatus: 409,
    description: 'The actor has linked session messages and cannot be deleted.',
  },
  FORBIDDEN: {
    httpStatus: 403,
    description:
      'The authenticated user does not have permission to perform this action.',
  },
  UNAUTHORIZED: {
    httpStatus: 401,
    description: 'Authentication is required or the token is invalid.',
  },
  VALIDATION_FAILED: {
    httpStatus: 400,
    description: 'The request body failed validation.',
  },
  TOOL_CALL_NOT_SUPPORTED: {
    httpStatus: 422,
    description:
      'This tool type cannot be invoked server-side. Client tools must be executed by the calling client.',
  },
  ORCHESTRATION_NOT_FOUND: {
    httpStatus: 404,
    description: 'The orchestration does not exist or is not accessible.',
  },
  ORCHESTRATION_RUN_NOT_FOUND: {
    httpStatus: 404,
    description: 'The orchestration run does not exist or is not accessible.',
  },
  ORCHESTRATION_NODE_FAILED: {
    httpStatus: 422,
    description: 'A node in the orchestration run failed to execute.',
  },
  ORCHESTRATION_VALIDATION_FAILED: {
    httpStatus: 400,
    description:
      'The orchestration graph is invalid (e.g. a dangling edge, a node missing a required field, a cycle, or an input_mapping that references a state key no upstream node writes).',
  },
  FORMATION_MISSING_PARAMETERS: {
    httpStatus: 400,
    description:
      'The formation template declares one or more required parameters (no default, not satisfied by use_previous_value) that were not supplied or were provided as an empty string.',
  },
  FORMATION_INVALID_METADATA: {
    httpStatus: 400,
    description:
      'The formation-level `metadata` field contains a `sub`/`param`/`ref`/`ref_attr` substitution expression. That field is a static annotation bag and is never resolved; put deploy-time substitutions in the template top-level `metadata` block instead.',
  },
  ORCHESTRATION_CYCLE_DETECTED: {
    httpStatus: 422,
    description:
      'The orchestration graph contains a cycle. Cycles are not supported.',
  },
  ORCHESTRATION_RUN_NOT_CANCELLABLE: {
    httpStatus: 409,
    description:
      'The orchestration run is already in a terminal state and cannot be cancelled.',
  },
  ORCHESTRATION_RUN_NOT_AWAITING_INPUT: {
    httpStatus: 409,
    description: 'The orchestration run is not awaiting input.',
  },
  ORCHESTRATION_HUMAN_NODE_MISMATCH: {
    httpStatus: 400,
    description:
      'The specified node is not the active human node waiting for input.',
  },
  ORCHESTRATION_MAX_ITERATIONS_EXCEEDED: {
    httpStatus: 422,
    description:
      'The orchestration run exceeded the maximum number of iterations.',
  },
  ORCHESTRATION_POLL_EXHAUSTED: {
    httpStatus: 422,
    description:
      'A poll node reached its attempt limit without its exit condition becoming true (only raised when fail_on_timeout is set).',
  },
  EMBEDDING_NOT_CONFIGURED: {
    httpStatus: 503,
    description:
      'The embedding service is not configured. Set EMBEDDING_PROVIDER and EMBEDDING_MODEL environment variables.',
  },
  PDF_PARSE_FAILED: {
    httpStatus: 400,
    description:
      'The uploaded file could not be parsed as a PDF. Ensure the file is a valid PDF document.',
  },
  FILE_PARSE_FAILED: {
    httpStatus: 400,
    description: 'The referenced file contains no extractable text.',
  },
  FILE_NOT_FOUND: {
    httpStatus: 400,
    description: 'The referenced file does not exist.',
  },
  UPLOAD_TOKEN_NOT_FOUND: {
    httpStatus: 404,
    description: 'The upload token does not exist.',
  },
  UPLOAD_TOKEN_EXPIRED: {
    httpStatus: 410,
    description: 'The upload token has expired. Request a new one.',
  },
  UPLOAD_TOKEN_USED: {
    httpStatus: 409,
    description: 'The upload token has already been used.',
  },
  UNSUPPORTED_FILE_TYPE: {
    httpStatus: 400,
    description:
      'The referenced file has a content type that cannot be ingested. Supported types: application/pdf, text/plain, text/markdown.',
  },
  INVALID_DISCUSSION_CONFIG: {
    httpStatus: 400,
    description:
      'The discussion config is invalid (e.g. max_rounds out of range, no participants, too many participants, or an invalid effort value).',
  },
  INVALID_OUTPUT_SCHEMA: {
    httpStatus: 400,
    description:
      'The agent output_schema is invalid — it must be a JSON Schema object.',
  },
  OUTPUT_SCHEMA_STREAMING_UNSUPPORTED: {
    httpStatus: 400,
    description:
      'Streaming generation does not support output_schema. Set stream to false, or remove output_schema from the agent/request.',
  },
  FILE_TOO_LARGE_FOR_SYNC: {
    httpStatus: 413,
    description:
      'The file is too large to ingest synchronously. Retry without `?async=false` (or with `?async=true`) to run ingestion in the background and poll the document status.',
  },
  PIPELINE_INVALID_STEP: {
    httpStatus: 400,
    description:
      'The pipeline tool configuration is invalid (e.g. no steps, a duplicate or malformed step id, a missing tool reference, a forward reference to a later step, or a step that targets a client tool).',
  },
  PIPELINE_STEP_FAILED: {
    httpStatus: 422,
    description: 'A step in the pipeline tool failed to execute.',
  },
  PIPELINE_DEPTH_EXCEEDED: {
    httpStatus: 422,
    description:
      'The pipeline tool exceeded the maximum nested execution depth (pipelines calling pipelines).',
  },
  INGESTION_RULE_VALIDATION_FAILED: {
    httpStatus: 400,
    description:
      'The ingestion rule configuration is invalid (e.g. tool_id and agent_id are both set or both missing, the converter tool is a client tool, a soat/mcp converter tool is missing an action, content_type_glob is not a valid MIME type glob, or preset_parameters contains the reserved key "file" or "callback").',
  },
  INGESTION_RULE_GLOB_CONFLICT: {
    httpStatus: 409,
    description:
      'An ingestion rule for this content_type_glob already exists in the project.',
  },
  CONVERTER_FAILED: {
    httpStatus: 422,
    description:
      'The ingestion converter (tool or agent) failed to run, an agent converter returned an async deferral (unsupported — agent converters are always awaited inline), or a tool converter returned an async deferral during synchronous ingestion (`?async=false`, which cannot wait for a callback).',
  },
  CONVERTER_OUTPUT_INVALID: {
    httpStatus: 422,
    description:
      'The ingestion converter returned an unrecognized output shape. Expected a string, `{ pages: [{ text, page_number }] }`, or `{ status: "pending" }`.',
  },
  FILE_DOWNLOAD_URL_NOT_CONFIGURED: {
    httpStatus: 500,
    description:
      'An ingestion rule with file_delivery: download_url requires SOAT_BASE_URL to be set — the URL is fetched by an external converter that cannot resolve a relative or localhost address.',
  },
  FILE_STORAGE_MISCONFIGURED: {
    httpStatus: 500,
    description:
      'The file storage backend is not configured correctly — an unknown FILES_STORAGE_PROVIDER, an unsupported storage type, or a missing required variable (e.g. FILES_STORAGE_DIR for local, FILES_S3_BUCKET for s3).',
  },
  INGESTION_CALLBACK_INVALID_TOKEN: {
    httpStatus: 401,
    description:
      'The ingestion-callback token is missing, malformed, expired, or does not match the target document.',
  },
  INGESTION_CALLBACK_CONFLICT: {
    httpStatus: 409,
    description:
      'The document is no longer awaiting this conversion attempt — it already completed, timed out, or was superseded by a re-ingest.',
  },
  TOOL_HTTP_ERROR: {
    httpStatus: 502,
    description:
      'An http-type tool call returned a non-2xx response. The error `meta` carries the real upstream status code, response body, URL, and method.',
  },
  INVALID_CRON_EXPRESSION: {
    httpStatus: 400,
    description:
      'The cron expression is invalid. Triggers require a strict 5-field cron expression evaluated in UTC.',
  },
  TRIGGER_TYPE_IMMUTABLE: {
    httpStatus: 400,
    description: 'A trigger’s type cannot be changed after creation.',
  },
  TRIGGER_TARGET_NOT_FOUND: {
    httpStatus: 400,
    description:
      'The trigger target does not exist in the project, or its type does not match target_type.',
  },
  TRIGGER_ACTION_NOT_ALLOWED: {
    httpStatus: 400,
    description:
      'A trigger field is incompatible with its type: `action` is only valid for tool targets (and required for soat/mcp tools), and `cron` is required for schedule triggers and rejected otherwise.',
  },
  TRIGGER_INPUT_INVALID: {
    httpStatus: 400,
    description:
      'The effective input is invalid for the target (empty agent input, or an orchestration input_schema violation).',
  },
  TRIGGER_NOT_ACTIVE: {
    httpStatus: 409,
    description: 'The trigger is inactive and cannot fire.',
  },
  TRIGGER_CREATOR_UNAVAILABLE: {
    httpStatus: 409,
    description:
      'The trigger creator no longer exists, so the firing identity cannot be resolved.',
  },
  TRIGGER_RECURSION_FORBIDDEN: {
    httpStatus: 403,
    description:
      'A trigger-scoped credential cannot fire a trigger, preventing unbounded trigger→trigger loops.',
  },
  HOOK_PAYLOAD_TOO_LARGE: {
    httpStatus: 413,
    description: 'The inbound hook request body exceeds the 1 MiB limit.',
  },
  HOOK_INVALID_JSON: {
    httpStatus: 400,
    description: 'The inbound hook request body is not valid JSON.',
  },
  APPROVAL_NOT_FOUND: {
    httpStatus: 404,
    description: 'The approval item does not exist or is not accessible.',
  },
  APPROVAL_ALREADY_RESOLVED: {
    httpStatus: 409,
    description:
      'The approval item has already been resolved (approved, rejected, or expired) and cannot be resolved again.',
  },
  APPROVAL_EXPIRED: {
    httpStatus: 409,
    description:
      'The approval item has expired and can never execute. Its supporting evidence is stale; a fresh proposal is required.',
  },
  APPROVAL_REASON_REQUIRED: {
    httpStatus: 400,
    description: 'A reason is required when rejecting an approval item.',
  },
  EXCEPTION_NOT_FOUND: {
    httpStatus: 404,
    description: 'The exception item does not exist or is not accessible.',
  },
  EXCEPTION_ALREADY_RESOLVED: {
    httpStatus: 409,
    description:
      'The exception item has already been resolved and cannot be acknowledged or resolved again.',
  },
  APPROVAL_INVALID_EDIT: {
    httpStatus: 400,
    description:
      'The edited arguments supplied on edit-then-approve must be a JSON object.',
  },
  WORKFLOW_NOT_FOUND: {
    httpStatus: 404,
    description: 'The workflow does not exist or is not accessible.',
  },
  WORKFLOW_VALIDATION_FAILED: {
    httpStatus: 400,
    description:
      'The workflow definition is invalid (e.g. duplicate state names, not exactly one initial state, a transition referencing an unknown state, a malformed guard, or an on_enter dispatch missing its target).',
  },
  WORKFLOW_HAS_OPEN_TASKS: {
    httpStatus: 409,
    description:
      'The workflow has one or more open tasks and cannot be deleted.',
  },
  TASK_NOT_FOUND: {
    httpStatus: 404,
    description: 'The task does not exist or is not accessible.',
  },
  TASK_PAYLOAD_INVALID: {
    httpStatus: 400,
    description:
      "The task payload does not satisfy the workflow's payload_schema.",
  },
  TASK_TRANSITION_NOT_FOUND: {
    httpStatus: 400,
    description: 'The named transition does not exist in the workflow.',
  },
  TASK_GUARD_REJECTED: {
    httpStatus: 400,
    description: 'The transition guard evaluated to false for this task.',
  },
  TASK_TRANSITION_CONFLICT: {
    httpStatus: 409,
    description:
      'A concurrent change made the requested transition invalid from the current state, or the task is already closed.',
  },
  GUARDRAIL_NOT_FOUND: {
    httpStatus: 400,
    description:
      'A guardrail referenced by a `guardrail_ids` attachment does not exist in the project.',
  },
  GUARDRAIL_HAS_REFERENCES: {
    httpStatus: 409,
    description:
      'The guardrail is still attached to one or more tools, agents, or projects (`guardrail_ids`) and cannot be deleted. Detach every reference first (requires guardrails:DetachGuardrail). The error meta lists the referencing resources by scope.',
  },
  QUOTA_EXCEEDED: {
    httpStatus: 429,
    description:
      'An enforced quota has been exceeded for the request scope. The response carries a `Retry-After` header (seconds until the window resets) and a `meta` block naming the breached quota, metric, limit, window, and reset time.',
  },
  QUOTA_CONFLICT: {
    httpStatus: 409,
    description:
      'A quota with the same (project, scope, scope_ref, metric, window) already exists. The all-enforce precedence rule makes duplicates pure redundancy, so a duplicate is rejected instead of stored.',
  },
} as const satisfies Record<
  string,
  { httpStatus: number; description: string }
>;

export type ErrorCode = keyof typeof ERROR_CODES;
