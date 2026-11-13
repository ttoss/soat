import crypto from 'node:crypto';

import { db } from 'src/db';
import {
  buildRunAuthHeader,
  readStoredStartingPrincipal,
} from 'src/lib/orchestrationRunToken';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * Work a capped callback starts keeps the cap: the turn it runs, the tool
 * calls the turn makes and the credential a later drive re-mints are each
 * held to the key ∩ the authority the assertion carried.
 */

const HEADER = 'X-Soat-On-Behalf-Of';

describe('work a capped callback starts', () => {
  let turn: AgentToolTurn;
  let projectKey: string;
  let projectKeyId: string;
  let mcpToolId: string;
  let mcpPath: string;
  let documentId: string;
  let builtinAgentId: string;
  let builtinToolName: string;
  let mcpAgentId: string;
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const mcpAssertions = (): string[] => {
    return turn.target
      .requestsAt(mcpPath)
      .filter((request) => {
        return request.body.method === 'tools/call';
      })
      .map((request) => {
        return request.headers['x-soat-tool-assertion'] as string;
      });
  };

  /** The assertion a direct call made on `credential` sends. */
  const directCallAssertion = async (credential: string): Promise<string> => {
    const res = await authenticatedTestClient(credential)
      .post(`/api/v1/tools/${mcpToolId}/call`)
      .send({ action: 'echo', input: {} });
    expect(res.status).toBe(200);
    return mcpAssertions().at(-1) as string;
  };

  /** An assertion whose authority allows calling tools and agents only. */
  const cappedAssertion = async (): Promise<string> => {
    const token = await authenticatedTestClient(projectKey)
      .post('/api/v1/iam/tokens')
      .send({
        policy: {
          statement: [
            { effect: 'Allow', action: ['tools:CallTool', 'agents:*'] },
          ],
        },
      });
    expect(token.status).toBe(201);
    return directCallAssertion(token.body.token as string);
  };

  const generate = (args: {
    agentId: string;
    assertion: string;
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  }) => {
    return authenticatedTestClient(projectKey)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .set(HEADER, args.assertion)
      .send({ messages: [proposeCalls(args.calls)] });
  };

  const readDocument = (credential: string, assertion?: string) => {
    const request = authenticatedTestClient(credential).get(
      `/api/v1/documents/${documentId}`
    );
    if (assertion) request.set(HEADER, assertion);
    return request;
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    process.env.TOOL_ASSERTION_PRIVATE_KEY = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'obowork' });

    mcpPath = `/${turn.unique('mcp')}`;
    turn.target.reply(mcpPath, (body) => {
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'echo' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { body: { jsonrpc: '2.0', id: body.id, result } };
    });
    const mcpTool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${mcpPath}` },
    });
    mcpToolId = mcpTool.id;
    mcpAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: mcpToolId }],
    });

    const builtin = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['get-document'],
    });
    builtinToolName = builtin.name;
    builtinAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: builtin.id }],
    });

    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;
    projectKeyId = key.body.id;

    const doc = await turn
      .api()
      .post('/api/v1/documents')
      .send({ project_id: turn.projectId, content: 'private guide' });
    expect(doc.status).toBe(201);
    documentId = doc.body.id;
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  describe('a generation started on a capped callback', () => {
    const readThroughTurn = async (assertion: string) => {
      const res = await generate({
        agentId: builtinAgentId,
        assertion,
        calls: [
          {
            name: `${builtinToolName}_get-document`,
            args: { document_id: documentId },
          },
        ],
      });
      expect(res.status).toBe(200);
      return { id: res.body.id as string, output: res.body.output.content };
    };

    test("refuses the turn's builtin call the cap does not allow", async () => {
      const full = await readThroughTurn(await directCallAssertion(projectKey));
      const capped = await readThroughTurn(await cappedAssertion());

      expect(JSON.parse(full.output)[0].id).toBe(documentId);
      expect(JSON.parse(capped.output)[0]).toMatch(
        /^DomainError: Forbidden: IAM token \S+'s policies deny documents:GetDocument on /
      );
    });

    test("caps the callback of the turn's mcp call", async () => {
      const callbackOf = async (assertion: string) => {
        const res = await generate({
          agentId: mcpAgentId,
          assertion,
          calls: [{ name: 'echo', args: {} }],
        });
        expect(res.status).toBe(200);
        return readDocument(projectKey, mcpAssertions().at(-1));
      };

      const full = await callbackOf(await directCallAssertion(projectKey));
      const capped = await callbackOf(await cappedAssertion());

      expect(full.status).toBe(200);
      expect(capped.status).toBe(403);
    });

    test('stores the cap, so a credential re-minted for it later is capped', async () => {
      const { id } = await readThroughTurn(await cappedAssertion());
      const gen = await db.Generation.findOne({ where: { publicId: id } });
      expect(gen!.actedAsPrincipalId).toBe(projectKeyId);

      const header = await buildRunAuthHeader({
        principal: readStoredStartingPrincipal({
          kind: gen!.actedAsPrincipalType,
          id: gen!.actedAsPrincipalId,
          bound: gen!.actedAsPrincipalBound,
        }),
        projectId: gen!.projectId as number,
        workPublicId: id,
      });

      expect((await readDocument(header!.slice('Bearer '.length))).status).toBe(
        403
      );
    });
  });
});
