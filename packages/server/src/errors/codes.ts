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
  GENERATION_NOT_FOUND: {
    httpStatus: 404,
    description:
      'The generation does not exist or is not in a pending state for tool output submission.',
  },
  GENERATION_ALREADY_IN_PROGRESS: {
    httpStatus: 409,
    description:
      'A generation is already in progress for this session. Wait for it to complete before starting a new one.',
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
} as const satisfies Record<
  string,
  { httpStatus: number; description: string }
>;

export type ErrorCode = keyof typeof ERROR_CODES;
