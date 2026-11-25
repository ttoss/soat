import type { LanguageModelMiddleware } from 'ai';
import createDebug from 'debug';

const log = createDebug('soat:model-input');

type CallParams = Parameters<
  NonNullable<LanguageModelMiddleware['transformParams']>
>[0]['params'];
type PromptMessage = CallParams['prompt'][number];
type UserPart = Extract<PromptMessage, { role: 'user' }>['content'][number];
type AssistantPart = Extract<
  PromptMessage,
  { role: 'assistant' }
>['content'][number];
type ToolResultPart = Extract<AssistantPart, { type: 'tool-result' }>;
type ContentItem = Extract<
  ToolResultPart['output'],
  { type: 'content' }
>['value'][number];

const text = (value: string): UserPart => {
  return { type: 'text', text: value };
};

const isUserPart = (item: ContentItem): item is ContentItem & UserPart => {
  return item.type !== 'custom';
};

const resultParts = (part: ToolResultPart): UserPart[] => {
  const { output, toolName } = part;
  if (output.type !== 'content') {
    return [text(`[tool ${toolName} returned ${JSON.stringify(output)}]`)];
  }
  return [
    text(`[tool ${toolName} returned]`),
    ...output.value.filter(isUserPart),
  ];
};

// An assistant message's own tool-result part is passed as is: soat binds no
// provider-executed tool.
const flattenAssistantPart = (part: AssistantPart): AssistantPart => {
  if (part.type !== 'tool-call') return part;
  return text(
    `[called tool ${part.toolName} with ${JSON.stringify(part.input)}]`
  );
};

const flattenMessage = (message: PromptMessage): PromptMessage => {
  if (message.role === 'tool') {
    const content = message.content.flatMap((part) => {
      return part.type === 'tool-result' ? resultParts(part) : [];
    });
    return { role: 'user', content };
  }
  if (message.role !== 'assistant') return message;
  return { ...message, content: message.content.map(flattenAssistantPart) };
};

/**
 * A call under `tool_choice: "none"` leaves with no tool and its history's
 * tool calls and results as text: providers map `none` their own way, and a
 * model offered a tool, or shown one in its history, can still call it.
 */
export const toToolFreeCall = (params: CallParams): CallParams => {
  if (params.toolChoice?.type !== 'none') return params;
  log('toToolFreeCall: messages=%d', params.prompt.length);
  return {
    ...params,
    tools: undefined,
    toolChoice: undefined,
    prompt: params.prompt.map(flattenMessage),
  };
};
