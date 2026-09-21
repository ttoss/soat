import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import { soatTools } from 'src/lib/soatTools';
import { operationIdToToolName } from 'src/lib/soatToolsHelpers';

/**
 * The generated client surfaces — MCP tools, the SDK, the CLI — wrap the REST
 * API, which lives entirely under `/api/v1`.
 *
 * `oauth.yaml` describes endpoints that do not: `/authorize`, `/token`,
 * `/register` and the two `.well-known` documents are mounted at the root by
 * `@ttoss/auth-core`, with paths the RFCs fix. They are in a spec so that a
 * client can *find* the flow, and wrapping them would be wrong rather
 * than merely useless: `/authorize` is a browser redirect with no response body
 * to return, and `/token` takes a form-encoded body that a JSON-shaped
 * generated caller cannot send. An agent handed a `soat`-namespaced tool for
 * either would be handed a broken one.
 *
 * So the rule is the path prefix, and it is checked rather than remembered —
 * the next spec that describes a root-level protocol endpoint inherits it.
 */
describe('generated tool surface covers the REST API only', () => {
  test('every tool targets a path under /api/v1', () => {
    const offenders = soatTools
      .filter((tool) => {
        return !tool.path({}).startsWith('/api/v1/');
      })
      .map((tool) => {
        return `${tool.name} → ${tool.method} ${tool.path({})}`;
      });

    expect(offenders).toEqual([]);
  });

  test('no tool is generated for the OAuth protocol endpoints', () => {
    const names = soatTools.map((tool) => {
      return tool.name;
    });

    for (const excluded of [
      'get-oauth-authorization-server-metadata',
      'get-oauth-protected-resource-metadata',
      'register-oauth-client',
      'authorize-oauth-client',
      'create-oauth-token',
    ]) {
      expect(names).not.toContain(excluded);
    }
  });
});

/**
 * A parameter a spec declares by `$ref` into a sibling file — the shape shared
 * components take, so a filter's grammar is written once — must still reach the
 * tool. A reference that resolves to nothing is dropped from the tool's inputs
 * silently, which serves the filter over REST and hides it from every agent.
 */
describe('shared parameters reach the tools that reference them', () => {
  const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

  type Referenced = { operationId: string; parameter: string };

  type SharedSpec = {
    components?: {
      parameters?: Record<string, { name?: string; in?: string }>;
    };
  };

  type PathsSpec = {
    paths?: Record<
      string,
      Record<string, { operationId?: string; parameters?: { $ref?: string }[] }>
    >;
  };

  const readSpec = <T>(file: string): T => {
    return load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf-8')) as T;
  };

  /**
   * The name a `$ref` resolves to, for a query parameter. A header is never a
   * tool input — a `soat` tool call carries a write precondition in the body —
   * so only the query half is measured here.
   */
  const queryParameterName = (ref: string): string | null => {
    const [file, pointer] = ref.split('#');
    if (!file || !pointer?.startsWith('/components/parameters/')) return null;
    const shared = readSpec<SharedSpec>(file);
    const parameter =
      shared.components?.parameters?.[
        pointer.replace('/components/parameters/', '')
      ];
    return parameter?.in === 'query' ? (parameter.name ?? null) : null;
  };

  const referencedIn = (spec: PathsSpec): Referenced[] => {
    const referenced: Referenced[] = [];
    for (const pathItem of Object.values(spec.paths ?? {})) {
      for (const operation of Object.values(pathItem)) {
        const operationId = operation.operationId;
        if (!operationId) continue;
        for (const parameter of operation.parameters ?? []) {
          const name =
            typeof parameter.$ref === 'string'
              ? queryParameterName(parameter.$ref)
              : null;
          if (name) referenced.push({ operationId, parameter: name });
        }
      }
    }
    return referenced;
  };

  const referencedQueryParameters = (): Referenced[] => {
    return fs
      .readdirSync(SPEC_DIR)
      .filter((file) => {
        return file.endsWith('.yaml');
      })
      .flatMap((file) => {
        return referencedIn(readSpec<PathsSpec>(file));
      });
  };

  test('every referenced query parameter is an input on its tool', () => {
    const referenced = referencedQueryParameters();
    // The shared files exist to be referenced; a run finding none has stopped
    // measuring anything.
    expect(referenced.length).toBeGreaterThan(0);

    const missing = referenced.filter(({ operationId, parameter }) => {
      const tool = soatTools.find((candidate) => {
        return candidate.name === operationIdToToolName(operationId);
      });
      return (
        tool !== undefined &&
        !(parameter in (tool.inputSchema?.properties ?? {}))
      );
    });

    expect(missing).toEqual([]);
  });
});
