const CONTENT_TYPE_GLOB_PATTERN = /^[a-zA-Z0-9*.+-]+\/[a-zA-Z0-9*.+-]+$/;

const isValidContentTypeGlob = (glob: string): boolean => {
  return CONTENT_TYPE_GLOB_PATTERN.test(glob);
};

const validateConverterToolType = (args: {
  toolType?: string | null;
  action?: string | null;
}): string | null => {
  if (args.toolType === 'client') {
    return 'client tools cannot be used as ingestion rule converters; they must be executed by the calling client, but ingestion runs server-side';
  }
  if ((args.toolType === 'soat' || args.toolType === 'mcp') && !args.action) {
    return 'action is required when the converter tool type is soat or mcp';
  }
  return null;
};

/**
 * Pure validation shared by the REST route and the formation module (see
 * .claude/rules/modules.md "Shared Business Rules"). No DB access — callers
 * resolve `toolId`/`agentId`/`toolType` beforehand.
 */
export const validateIngestionRule = (args: {
  toolId?: string | number | null;
  agentId?: string | number | null;
  toolType?: string | null;
  action?: string | null;
  contentTypeGlob: string;
}): string | null => {
  if (args.toolId && args.agentId) {
    return 'tool_id and agent_id are mutually exclusive';
  }
  if (!args.toolId && !args.agentId) {
    return 'exactly one of tool_id or agent_id is required';
  }
  const toolTypeError = args.toolId
    ? validateConverterToolType({
        toolType: args.toolType,
        action: args.action,
      })
    : null;
  if (toolTypeError) {
    return toolTypeError;
  }
  if (!isValidContentTypeGlob(args.contentTypeGlob)) {
    return 'content_type_glob must be a valid MIME type glob (e.g. "image/*", "image/png", "*/*")';
  }
  return null;
};
