import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTestEnv } from './testEnv';

applyTestEnv();

export const storageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'soat-convo-test-')
);

process.env.FILES_STORAGE_DIR = storageDir;
// Give each Jest worker its own base port. `src/mcp/server.ts` freezes
// `http://localhost:${process.env.PORT}` at module load (this setupFile runs
// before that import), and soat tool self-calls read `process.env.PORT` at call
// time. Workers run in parallel and a bound port is OS-global, so a single
// shared port makes mcp.test — which binds it to serve its own self-calls —
// collide with tools.test, which needs that port unbound to assert a self-call
// failure. A per-worker port keeps every file hermetic regardless of how Jest
// schedules them. JEST_WORKER_ID is always set (>=1), including under
// --runInBand.
process.env.PORT = String(15047 + Number(process.env.JEST_WORKER_ID ?? '1'));
