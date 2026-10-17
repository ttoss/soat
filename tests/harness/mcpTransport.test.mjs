import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(path.join(libDir, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const filesMatching = (pattern) => {
  return fs
    .readdirSync(libDir)
    .filter((entry) => {
      return entry.endsWith('.ts') && pattern.test(code(entry));
    })
    .sort();
};

/**
 * An `mcp` tool's requests are signed where they are sent (`postMcp`), so a
 * site that sends one by hand is a request the receiver cannot attribute.
 */
describe('mcp transport chokepoint', () => {
  test('outbound tool traffic leaves lib/ only through the known senders', () => {
    assert.deepEqual(filesMatching(/\bfetchWithEgressGuard\(/), [
      // `http` tools.
      'agentToolResolver.ts',
      // AI SDK provider requests, not tool calls.
      'egressFetch.ts',
      'mcpTransport.ts',
      // The GCP token exchange behind an `http` tool's auth.
      'toolAuthGcp.ts',
      'webhookDispatcher.ts',
    ]);
  });

  test('MCP request headers are assembled only by openMcpTransport', () => {
    assert.deepEqual(
      filesMatching(/['"]application\/json, text\/event-stream['"]/),
      ['mcpTransport.ts']
    );
  });
});
