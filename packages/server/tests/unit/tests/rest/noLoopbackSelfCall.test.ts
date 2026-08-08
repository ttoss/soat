import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nothing on a tool surface reaches the platform over the network any more.
 * Both the agent-side `soat` tool (#888) and the MCP tool surface dispatch
 * in-process, through the app's own middleware chain.
 *
 * This is a static check for the same reason `wireKeyContract` is one: the
 * failure it guards is a *reintroduction*, and the reintroduction passes every
 * behavioral test. A tool that self-called `http://localhost:$PORT` would work
 * perfectly in any environment where the server happens to be listening —
 * production, a dev machine, a smoke stack — and fail only where it isn't. The
 * unit suite binds no listener today precisely so that gap is visible, but a
 * future test file that binds one (as `mcp.test.ts` used to) would hide it
 * again. Reading the source catches the class.
 *
 * What the loopback cost, and what a new one would cost again: a bearer token
 * has to be minted and handed to any background caller just to satisfy the hop
 * (#879, #884); a non-2xx arrives as a body to be interpreted rather than a
 * failure, which is how a `401` was served as tool *data* for years; and every
 * call pays a process hop plus a JSON round trip.
 *
 * The check is deliberately narrow — it looks only at how the tool surfaces
 * reach **SOAT itself**. Fetching an *external* URL is what `http` and `mcp`
 * tools are for, and `agentToolResolverExternalTools` is full of legitimate
 * outbound `fetch` calls to caller-supplied hosts.
 */

const SRC_DIR = join(__dirname, '../../../../src');

/**
 * Files that own how a tool surface reaches SOAT. A self-call would be written
 * here, next to the dispatch it replaced, which is what makes a path list
 * enough — and keeps the check from flagging outbound calls elsewhere.
 */
const TOOL_SURFACE_FILES = [
  'mcp/server.ts',
  'mcp/dispatchApi.ts',
  'mcp/toMcpText.ts',
  'lib/soatTools.ts',
  'lib/soatToolsHelpers.ts',
  'lib/toolsCall.ts',
  'lib/inProcessApi.ts',
];

/**
 * A URL pointing back at this process: an explicit loopback host, or a
 * template whose host is built from `PORT` (`http://localhost:${PORT}` was the
 * exact former shape).
 */
const SELF_CALL_URL =
  /(['"`])https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\$\{[^}]*(?:PORT|port)[^}]*\})/;

const readSource = (relativePath: string): string => {
  return readFileSync(join(SRC_DIR, relativePath), 'utf8');
};

/** Strips comments so prose *describing* the old loopback is not a violation. */
const stripComments = (source: string): string => {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
};

describe('tool surfaces do not self-call over the loopback', () => {
  test.each(TOOL_SURFACE_FILES)('%s builds no self-call URL', (file) => {
    const code = stripComments(readSource(file));
    expect(code).not.toMatch(SELF_CALL_URL);
  });

  test('the MCP tool handler dispatches in-process rather than fetching', () => {
    const code = stripComments(readSource('mcp/server.ts'));

    expect(code).toContain('dispatchMcpApiRequest');
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  test('the soat tool executor dispatches in-process rather than fetching', () => {
    const code = stripComments(
      readSource('lib/agentToolResolverExternalTools.ts')
    );

    // Outbound `fetch` to a caller-supplied host stays — that is what `http`
    // and `mcp` tools do. What must not come back is a fetch of a SOAT URL.
    expect(code).toContain('dispatchApiRequestOrThrow');
    expect(code).not.toMatch(SELF_CALL_URL);
  });

  test('every listed file exists, so a rename cannot silently empty the check', () => {
    for (const file of TOOL_SURFACE_FILES) {
      expect(statSync(join(SRC_DIR, file)).isFile()).toBe(true);
    }
  });

  test('no src file anywhere fetches a URL it built from its own PORT', () => {
    // A sweep, so a self-call reintroduced in a *new* file is caught too — the
    // path list above only covers the files that own this today.
    //
    // Both halves are required. Building `http://host:${PORT}` is legitimate
    // and common: `oauth/server.ts` derives `ISSUER` from it (the server's own
    // public identity, which OAuth discovery must advertise), and `server.ts`
    // logs it at startup. Calling `fetch` is equally legitimate on its own —
    // that is what an `http` tool does. Only a file that does both is building
    // a URL back to itself in order to call it.
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const code = stripComments(readFileSync(full, 'utf8'));
        const buildsSelfUrl =
          /https?:\/\/[^'"`]*\$\{[^}]*(?:PORT|port)[^}]*\}/.test(code) ||
          SELF_CALL_URL.test(code);
        if (buildsSelfUrl && /\bfetch\s*\(/.test(code)) {
          offenders.push(full.slice(SRC_DIR.length + 1));
        }
      }
    };

    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
