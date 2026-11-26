import type { JSONValue, Tool } from 'ai';

import type { AuthUser } from '../Context';
import { db } from '../db';
import type { AgentAuthority } from './agentAuthority';
import { claimSingleUseFiles } from './fileLifetime';
import {
  type FileMessageContentPart,
  resolveFileContentPart,
} from './messageFileParts';
import type { WorkAuthority } from './workAuthority';

type TextToolOutputPart = { type: 'text'; text: string };

export type ToolOutputPart = FileMessageContentPart | TextToolOutputPart;

const hasExactly = (value: unknown, keys: string[]): value is object => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => {
      return typeof Reflect.get(value, key) === 'string';
    })
  );
};

// Exact keys, so an output that only resembles a part stays JSON.
const isFilePart = (value: unknown): value is FileMessageContentPart => {
  return (
    hasExactly(value, ['type', 'file_id']) &&
    Reflect.get(value, 'type') === 'file'
  );
};

const isToolOutputPart = (value: unknown): value is ToolOutputPart => {
  return (
    isFilePart(value) ||
    (hasExactly(value, ['type', 'text']) &&
      Reflect.get(value, 'type') === 'text')
  );
};

/**
 * The parts of a tool output that returns files: one `file` part, or an array
 * of `text` and `file` parts holding at least one file. Null for any other
 * output, which reaches the model as it is.
 */
export const toolOutputParts = (output: unknown): ToolOutputPart[] | null => {
  if (isFilePart(output)) return [output];
  if (!Array.isArray(output) || !output.some(isFilePart)) return null;
  return output.every(isToolOutputPart) ? output : null;
};

/**
 * Refuses a file a tool output returns that `authority` may not download, as
 * the result enters the turn, and claims a single-use one for `generationId`;
 * the input boundary sends what passes as a native file part
 * (`modelInputBoundary.ts`).
 */
export const assertToolOutputFilesReadable = async (args: {
  output: unknown;
  turnProjectId: number;
  generationId: string;
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  agentAuthority?: AgentAuthority;
}): Promise<void> => {
  const fileIds: string[] = [];
  for (const part of toolOutputParts(args.output) ?? []) {
    if (part.type !== 'file') continue;
    await resolveFileContentPart({ ...args, part });
    fileIds.push(part.file_id);
  }
  if (fileIds.length === 0) return;
  await db.sequelize.transaction((transaction) => {
    return claimSingleUseFiles({
      fileIds,
      projectId: args.turnProjectId,
      generationId: args.generationId,
      transaction,
    });
  });
};

/** A client-submitted output as a tool result: a file output stays JSON. */
export const clientToolResultOutput = (
  output: unknown
): { type: 'text'; value: string } | { type: 'json'; value: JSONValue } => {
  if (typeof output === 'string') return { type: 'text', value: output };
  const parts = toolOutputParts(output);
  if (parts) return { type: 'json', value: parts };
  return { type: 'text', value: JSON.stringify(output) };
};

/** Every server tool's file output is read under the turn's authority. */
export const withReadableFileOutputs = (args: {
  tools: Record<string, Tool>;
  turnProjectId: number;
  generationId: string;
  authority: WorkAuthority | null;
}): Record<string, Tool> => {
  return Object.fromEntries(
    Object.entries(args.tools).map(([name, resolved]) => {
      const { execute } = resolved;
      if (!execute) return [name, resolved];
      return [
        name,
        {
          ...resolved,
          execute: async (...executeArgs: Parameters<typeof execute>) => {
            const output = await execute(...executeArgs);
            await assertToolOutputFilesReadable({
              output,
              turnProjectId: args.turnProjectId,
              generationId: args.generationId,
              authority: args.authority,
            });
            return output;
          },
        },
      ];
    })
  );
};
