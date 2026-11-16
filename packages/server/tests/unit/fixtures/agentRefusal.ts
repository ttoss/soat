import { docsUrlFor, resolutionFor } from 'src/errors';

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/** What every error body carries beside a `FORBIDDEN` code. */
export const forbiddenHints = () => {
  return {
    hint: resolutionFor({ code: 'FORBIDDEN' }),
    docs_url: docsUrlFor({ code: 'FORBIDDEN' }),
  };
};

/**
 * The tool result a model reads when agent `agentId`'s `policy_ids` refuse
 * `action`, whatever resource the call named: the body a REST refusal answers,
 * `hint` and `docs_url` included.
 */
export const agentRefusal = (args: { agentId: string; action: string }) => {
  return {
    error: {
      code: 'FORBIDDEN',
      message: expect.stringMatching(
        new RegExp(
          `^Forbidden: agent ${escapeRegExp(args.agentId)}'s policies deny ${escapeRegExp(args.action)}( on |$)`
        )
      ),
      ...forbiddenHints(),
      meta: expect.objectContaining({
        action: args.action,
        denied_by: { type: 'agent', id: args.agentId },
      }),
    },
  };
};
