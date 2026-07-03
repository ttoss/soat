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
  SECRET_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The secret is referenced by one or more AI providers and cannot be deleted. Use force=true to delete dependents as well.',
  },
  AI_PROVIDER_HAS_DEPENDENTS: {
    httpStatus: 409,
    description:
      'The AI provider is referenced by one or more chats and cannot be deleted. Delete the dependent chats first.',
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
  ORCHESTRATION_RUN_NOT_PAUSED: {
    httpStatus: 409,
    description: 'The orchestration run is not paused.',
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
  INVALID_REASONING_CONFIG: {
    httpStatus: 400,
    description:
      'The agent reasoning config is invalid (e.g. an unknown mode, no pipeline steps, too many steps, a duplicate or unnamed step, a step missing a prompt, an unknown step kind, or a fanout count/rounds out of range).',
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
} as const satisfies Record<
  string,
  { httpStatus: number; description: string }
>;

export type ErrorCode = keyof typeof ERROR_CODES;
