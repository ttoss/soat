/**
 * The vocabulary every outbound tool call shares, whatever protocol it speaks.
 *
 * Its own leaf module so `agentToolResolverMcp.ts` and
 * `agentToolResolverExternalTools.ts` — the `mcp` and `builtin` halves of
 * external tool calling — can each import it without importing each other.
 */

/** How long an outbound tool call may take before it is abandoned. */
export const SOAT_TOOL_CALL_TIMEOUT_MS = process.env.SOAT_TOOL_CALL_TIMEOUT_MS
  ? parseInt(process.env.SOAT_TOOL_CALL_TIMEOUT_MS, 10)
  : 300_000;

export type LogToolCallingError = (args: {
  toolName: string;
  toolType: 'http' | 'mcp' | 'builtin' | 'client';
  url?: string;
  method?: string;
  error: unknown;
}) => void;
