import type { SoatToolDefinition } from './types';

export const generationsDefinitions: SoatToolDefinition[] = [
  {
    name: 'create-agent-generation',
    description:
      'Run a generation on an agent. Sends messages and runs the AI loop. ' +
      'Client tools may pause the generation with requires_action.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/generate`;
    },
    body: (args) => {
      return {
        messages: args.messages,
        traceId: args.traceId,
        toolContext: args.toolContext,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['system', 'user', 'assistant'],
              },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
          description: 'Ordered list of messages to send',
        },
        traceId: {
          type: 'string',
          description: 'Optional trace ID to group generations',
        },
        toolContext: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Key-value pairs injected as context headers into all tool call requests made during this generation',
        },
      },
      required: ['agentId', 'messages'],
    },
    iamAction: 'agents:CreateAgentGeneration',
  },
  {
    name: 'submit-agent-tool-outputs',
    description: 'Submit tool outputs to resume a paused agent generation.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/generate/${args.generationId}/tool-outputs`;
    },
    body: (args) => {
      return {
        toolOutputs: args.toolOutputs,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        generationId: {
          type: 'string',
          description: 'Public ID of the paused generation',
        },
        toolOutputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              toolCallId: {
                type: 'string',
                description: 'ID of the tool call to respond to',
              },
              output: { description: 'Result of the tool execution' },
            },
            required: ['toolCallId', 'output'],
          },
          description: 'Tool outputs for each pending tool call',
        },
      },
      required: ['agentId', 'generationId', 'toolOutputs'],
    },
    iamAction: 'agents:SubmitAgentToolOutputs',
  },
];
