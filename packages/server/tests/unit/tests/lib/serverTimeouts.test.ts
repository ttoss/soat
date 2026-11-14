import { createServer } from 'node:http';

import { applyServerTimeouts } from 'src/lib/serverTimeouts';

// The longest idle timeout a load balancer in front of the server is expected
// to hold a reused connection for (AWS ALB as deployed, GCP's fixed keepalive).
const LOAD_BALANCER_IDLE_TIMEOUT_MS = 600_000;

describe('applyServerTimeouts', () => {
  test('keeps an idle connection open longer than the load balancer reuses it', () => {
    const server = createServer();
    applyServerTimeouts({ server });
    expect(server.keepAliveTimeout).toBeGreaterThan(
      LOAD_BALANCER_IDLE_TIMEOUT_MS
    );
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  test('never cuts off a long-running request', () => {
    const server = createServer();
    applyServerTimeouts({ server });
    expect(server.requestTimeout).toBe(0);
  });
});
