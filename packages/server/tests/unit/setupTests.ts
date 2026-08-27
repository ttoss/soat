import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTestEnv } from './testEnv';

applyTestEnv();

export const storageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'soat-convo-test-')
);

process.env.FILES_STORAGE_DIR = storageDir;
// A bound port is OS-global, so one shared port makes mcp.test (which binds it)
// collide with tools.test (which needs it unbound to assert a self-call
// failure). A per-worker port keeps every file hermetic under any schedule.
process.env.PORT = String(15047 + Number(process.env.JEST_WORKER_ID ?? '1'));
