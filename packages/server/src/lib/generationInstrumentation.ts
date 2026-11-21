/**
 * The one place a running generation's steps and tool calls are recorded: the
 * SDK's step and tool-execution callbacks of every model call, handed out by
 * `segmentCallOptions`. It sees every tool with an `execute`, whatever bound
 * it (a stored or inline tool, knowledge, memory).
 */
import type { Tool } from 'ai';
import createDebug from 'debug';

import { recordToolExecuted, toolActivityOf } from './agentToolActivity';
import {
  type ProgressEventType,
  recordProgress,
  type ToolCallStatus,
} from './generationProgress';
import { markedStatusOf } from './toolCallOutcome';

const log = createDebug('soat:generation-progress');

type ToolCallEvent = {
  toolCall: { toolCallId: string; toolName: string };
};

type ToolCallEndEvent = ToolCallEvent & {
  toolExecutionMs: number;
  toolOutput: { type: string; output?: unknown };
};

const toolCallStatusOf = (
  toolOutput: ToolCallEndEvent['toolOutput']
): ToolCallStatus => {
  if (toolOutput.type === 'tool-error') return 'failed';
  return markedStatusOf(toolOutput.output) ?? 'executed';
};

export type GenerationInstrumentation = {
  onStepStart: (event: { stepNumber: number }) => Promise<void>;
  stepEnded: (stepNumber: number) => Promise<void>;
  onToolExecutionStart: (event: ToolCallEvent) => Promise<void>;
  onToolExecutionEnd: (event: ToolCallEndEvent) => Promise<void>;
};

/**
 * The callbacks of one model call of `generationId`, whose steps start at
 * `firstIndex` within the turn. `tools` is the set the call runs: a tool's
 * activity mark is read from it.
 */
export const generationInstrumentation = (args: {
  generationId: string;
  firstIndex: number;
  tools: Record<string, Tool>;
}): GenerationInstrumentation => {
  const { generationId, firstIndex, tools } = args;
  let stepIndex = firstIndex;

  const recordStep = (type: ProgressEventType, stepNumber: number) => {
    return recordProgress({
      generationId,
      fact: { type, stepIndex: firstIndex + stepNumber },
    });
  };

  const markOf = (toolName: string) => {
    const resolved = Object.hasOwn(tools, toolName) ? tools[toolName] : null;
    return resolved ? toolActivityOf(resolved) : undefined;
  };

  // The one recorder of a tool call: its progress row and, for a call that
  // ran its tool, the activity entry.
  const recordToolCall = (call: {
    toolCallId: string;
    toolName: string;
    end: { status: ToolCallStatus; durationMs: number } | null;
  }) => {
    const { end } = call;
    log(
      'recordToolCall: generationId=%s toolCallId=%s ended=%s',
      generationId,
      call.toolCallId,
      end?.status
    );
    const mark = end?.status === 'executed' ? markOf(call.toolName) : undefined;
    if (mark) recordToolExecuted(mark);
    return recordProgress({
      generationId,
      fact: {
        type: end
          ? 'generations.tool_call_ended'
          : 'generations.tool_call_started',
        stepIndex,
        toolCallId: call.toolCallId,
        status: end?.status,
        durationMs: end && Math.round(end.durationMs),
      },
    });
  };

  return {
    onStepStart: (event) => {
      stepIndex = firstIndex + event.stepNumber;
      return recordStep('generations.step_started', event.stepNumber);
    },
    stepEnded: (stepNumber) => {
      return recordStep('generations.step_ended', stepNumber);
    },
    onToolExecutionStart: (event) => {
      return recordToolCall({ ...event.toolCall, end: null });
    },
    onToolExecutionEnd: (event) => {
      return recordToolCall({
        ...event.toolCall,
        end: {
          status: toolCallStatusOf(event.toolOutput),
          durationMs: event.toolExecutionMs,
        },
      });
    },
  };
};
