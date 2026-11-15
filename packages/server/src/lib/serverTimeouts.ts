import type { Server } from 'node:http';

// Above the 600 s idle timeout a fronting load balancer reuses a connection for
// (AWS ALB as deployed, GCP's fixed keepalive): a server that closes an idle
// connection first races that reuse, and the balancer answers 502.
const KEEP_ALIVE_TIMEOUT_MS = 620_000;

export const applyServerTimeouts = (args: { server: Server }): void => {
  args.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  args.server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;
  // Long-running LLM generations can take many minutes.
  args.server.requestTimeout = 0;
};
