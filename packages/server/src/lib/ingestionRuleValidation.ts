import {
  MAX_CONTENT_TYPE_GLOB_LENGTH,
  MAX_CONTENT_TYPE_GLOB_WILDCARDS,
} from './requestBounds';
import { serverSideToolProblem } from './toolsCallDispatch';

export type ConverterTool = { type: string; presetParameters: object | null };

const CONTENT_TYPE_GLOB_PATTERN = /^[a-zA-Z0-9*.+-]+\/[a-zA-Z0-9*.+-]+$/;

const isValidContentTypeGlob = (glob: string): boolean => {
  return (
    glob.length <= MAX_CONTENT_TYPE_GLOB_LENGTH &&
    (glob.match(/\*/g) ?? []).length <= MAX_CONTENT_TYPE_GLOB_WILDCARDS &&
    CONTENT_TYPE_GLOB_PATTERN.test(glob)
  );
};

const CONVERTER_TOOL_PROBLEMS = {
  runs_on_client:
    'client tools cannot be used as ingestion rule converters; they must be executed by the calling client, but ingestion runs server-side',
  action_required:
    'action is required when the converter tool type is soat or mcp, unless preset_parameters names it',
} as const;

const validateConverterTool = (args: {
  tool: ConverterTool | null;
  action?: string | null;
  presetParameters?: object | null;
}): string | null => {
  if (!args.tool) return null;
  const problem = serverSideToolProblem({
    tool: args.tool,
    action: args.action,
    // The converter's input is the rule's presets plus `file` and `callback`.
    input: args.presetParameters,
  });
  return problem ? CONVERTER_TOOL_PROBLEMS[problem] : null;
};

const VALID_CHUNK_STRATEGIES = new Set(['page', 'whole', 'size']);

const validateChunkStrategy = (
  chunkStrategy?: string | null
): string | null => {
  if (chunkStrategy == null) return null;
  if (!VALID_CHUNK_STRATEGIES.has(chunkStrategy)) {
    return `chunk_strategy must be one of "page", "whole", "size" (received "${chunkStrategy}")`;
  }
  return null;
};

const RESERVED_PRESET_PARAMETER_KEYS = ['file', 'callback'];

const validatePresetParameters = (
  presetParameters?: object | null
): string | null => {
  if (!presetParameters) return null;
  const reservedKeyUsed = RESERVED_PRESET_PARAMETER_KEYS.find((key) => {
    return key in presetParameters;
  });
  if (reservedKeyUsed) {
    return `preset_parameters cannot contain the reserved key "${reservedKeyUsed}" — it is injected by ingestion`;
  }
  return null;
};

/**
 * Pure validation shared by the REST route and the formation module (see
 * .claude/rules/modules.md "Shared Business Rules"). No DB access — callers
 * resolve `toolId`/`agentId`/`tool` beforehand.
 */
export const validateIngestionRule = (args: {
  toolId?: string | number | null;
  agentId?: string | number | null;
  tool: ConverterTool | null;
  action?: string | null;
  contentTypeGlob: string;
  presetParameters?: object | null;
  chunkStrategy?: string | null;
}): string | null => {
  if (args.toolId && args.agentId) {
    return 'tool_id and agent_id are mutually exclusive';
  }
  if (!args.toolId && !args.agentId) {
    return 'exactly one of tool_id or agent_id is required';
  }
  const toolTypeError = args.toolId
    ? validateConverterTool({
        tool: args.tool,
        action: args.action,
        presetParameters: args.presetParameters,
      })
    : null;
  if (toolTypeError) {
    return toolTypeError;
  }
  if (!isValidContentTypeGlob(args.contentTypeGlob)) {
    return `content_type_glob must be a valid MIME type glob (e.g. "image/*", "image/png", "*/*"), at most ${MAX_CONTENT_TYPE_GLOB_LENGTH} characters and ${MAX_CONTENT_TYPE_GLOB_WILDCARDS} wildcards`;
  }
  const presetParametersError = validatePresetParameters(args.presetParameters);
  if (presetParametersError) {
    return presetParametersError;
  }
  const chunkStrategyError = validateChunkStrategy(args.chunkStrategy);
  if (chunkStrategyError) {
    return chunkStrategyError;
  }
  return null;
};
