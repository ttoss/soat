import type { db } from '../db';
import { triggerOrReturnMessage } from './sessionMessageHelpers';

type GenerateSessionResponseFn = (args: {
  agentId: number;
  sessionId: string;
  toolContext?: Record<string, string>;
}) => Promise<unknown>;

// ── In-memory delay timer map ─────────────────────────────────────────────
// Key: `${agentId}#${sessionId}` — one pending timer per session.
// Implements debounce: each new message cancels the previous timer and
// schedules a fresh one. The LLM is only called after the delay elapses
// without another message arriving.
const sessionDelayTimers = new Map<string, NodeJS.Timeout>();

export const cancelDelayTimer = (sessionKey: string) => {
  const timer = sessionDelayTimers.get(sessionKey);
  if (timer) {
    clearTimeout(timer);
    sessionDelayTimers.delete(sessionKey);
  }
};

export const scheduleDelayedGeneration = (args: {
  sessionKey: string;
  agentId: number;
  sessionId: string;
  delayMs: number;
  toolContext?: Record<string, string>;
  generateFn: GenerateSessionResponseFn;
}) => {
  cancelDelayTimer(args.sessionKey);
  const timer = setTimeout(() => {
    sessionDelayTimers.delete(args.sessionKey);
    args
      .generateFn({
        agentId: args.agentId,
        sessionId: args.sessionId,
        toolContext: args.toolContext,
      })
      .catch(() => {});
  }, args.delayMs);
  sessionDelayTimers.set(args.sessionKey, timer);
};

export const triggerOrScheduleGeneration = (args: {
  session: InstanceType<(typeof db)['Session']>;
  agentId: number;
  sessionId: string;
  savedContent: string | null;
  savedDocumentId: string | undefined;
  toolContext?: Record<string, string>;
  generateFn: GenerateSessionResponseFn;
}) => {
  const delayMs = (args.session.messageDelaySeconds ?? 0) * 1000;
  const sessionKey = `${args.agentId}#${args.sessionId}`;

  if (delayMs > 0 && args.session.autoGenerate && !args.session.generatingAt) {
    scheduleDelayedGeneration({
      sessionKey,
      agentId: args.agentId,
      sessionId: args.sessionId,
      delayMs,
      toolContext: args.toolContext,
      generateFn: args.generateFn,
    });
    return {
      role: 'user' as const,
      content: args.savedContent,
      documentId: args.savedDocumentId,
    };
  }

  return triggerOrReturnMessage({
    session: args.session,
    agentId: args.agentId,
    sessionId: args.sessionId,
    toolContext: args.toolContext,
    savedContent: args.savedContent,
    savedDocumentId: args.savedDocumentId,
    generateFn: args.generateFn,
  });
};
