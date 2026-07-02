import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testClient } from '../../testClient';

let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'soat-app-test-'));
  writeFileSync(
    join(distDir, 'index.html'),
    '<!doctype html><html><body>SOAT</body></html>'
  );
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'assets', 'main.js'), 'console.log("main")');
  process.env.APP_DIST_PATH = distDir;
});

afterAll(() => {
  delete process.env.APP_DIST_PATH;
  rmSync(distDir, { recursive: true, force: true });
});

describe('SPA static serving at /app', () => {
  test('GET /app serves index.html', async () => {
    const res = await testClient.get('/app');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain('SOAT');
  });

  test('GET /app/ serves index.html', async () => {
    const res = await testClient.get('/app/');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
  });

  test('GET /app/unknown-route falls back to index.html', async () => {
    const res = await testClient.get('/app/some/nested/route');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain('SOAT');
  });

  test('GET /app/assets/main.js serves the asset file', async () => {
    const res = await testClient.get('/app/assets/main.js');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/javascript/);
  });

  test('non-/app paths are not handled by the SPA middleware', async () => {
    const res = await testClient.get('/health');
    expect(res.status).toBe(200);
    expect(res.type).not.toMatch(/html/);
  });

  test('an unmatched non-/app path falls through the SPA middleware to a 404', async () => {
    // Unlike /health (handled earlier by addHealthCheck), this path isn't
    // matched by any router, so it reaches the SPA middleware's own
    // `!ctx.path.startsWith('/app')` fallthrough before Koa's default 404.
    const res = await testClient.get('/this-path-does-not-exist-anywhere');
    expect(res.status).toBe(404);
    expect(res.type).not.toMatch(/html/);
  });

  test('GET /app returns 404 when dist dir does not exist', async () => {
    const saved = process.env.APP_DIST_PATH;
    process.env.APP_DIST_PATH = '/tmp/soat-nonexistent-dist-xyz';
    const res = await testClient.get('/app');
    process.env.APP_DIST_PATH = saved;
    expect(res.status).toBe(404);
  });
});
