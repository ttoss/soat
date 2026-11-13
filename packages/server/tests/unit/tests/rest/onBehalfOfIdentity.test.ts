import crypto from 'node:crypto';

import {
  type AssertionAuthority,
  sealAssertionAuthority,
} from 'src/lib/assertionAuthority';
import { ISSUER } from 'src/lib/serverIssuer';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

/**
 * A request carrying `On-Behalf-Of` for a generation runs as the key capped by
 * the authority the call was sent with and by that generation's execution
 * identity: its caller and its agent's `policy_ids`, `${iam:ActorId}` bound
 * to its actor.
 */

const HEADER = 'X-Soat-On-Behalf-Of';

// The sender's own authority allows everything, so only the generation caps.
const SENDER_AUTHORITY: AssertionAuthority = {
  sets: [
    [{ statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }] }],
  ],
};

const encode = (value: object): string => {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
};

describe('On-Behalf-Of execution identity', () => {
  let turn: AgentToolTurn;
  let privateKey: crypto.KeyObject;
  let kid: string;
  let projectKey: string;
  let toolId: string;
  let mcpPath: string;
  let deniedGeneration: string;
  let taggedGeneration: string;
  let uncappedGeneration: string;
  let narrowCallerGeneration: string;
  let runAsAgentGeneration: string;
  let blueDoc: string;
  let redDoc: string;
  let actorId: string;
  let actorDoc: string;
  let otherActorDoc: string;
  let actorGeneration: string;
  let triggerGeneration: string;
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const ECHO = [{ name: 'echo', args: {} }];

  const assertion = (generationId: string): string => {
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER,
      aud: `${turn.target.baseUrl}${mcpPath}`,
      iat,
      exp: iat + 60,
      jti: crypto.randomUUID(),
      tool_id: toolId,
      project_id: turn.projectId,
      generation_id: generationId,
      ath: sealAssertionAuthority({ authority: SENDER_AUTHORITY }),
    };
    const input = `${encode({ alg: 'EdDSA', typ: 'JWT', kid })}.${encode(claims)}`;
    const signature = crypto.sign(null, Buffer.from(input), privateKey);
    return `${input}.${signature.toString('base64url')}`;
  };

  const createDocument = async (tags: Record<string, string>) => {
    const res = await turn
      .api()
      .post('/api/v1/documents')
      .send({ project_id: turn.projectId, content: 'obo', tags });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const updateDocument = (args: {
    documentId: string;
    generationId?: string;
  }) => {
    const request = authenticatedTestClient(projectKey).patch(
      `/api/v1/documents/${args.documentId}`
    );
    if (args.generationId) request.set(HEADER, assertion(args.generationId));
    return request.send({ metadata: { touched: 'yes' } });
  };

  const createPolicy = (statement: object[]) => {
    return turn.createPolicy({ statement });
  };

  const agentWith = (policyIds?: string[]) => {
    return turn.createAgent({
      tool_bindings: [{ tool_id: toolId }],
      ...(policyIds ? { policy_ids: policyIds } : {}),
    });
  };

  const generationAsActor = async (agentId: string): Promise<string> => {
    const session = await turn
      .api()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, actor_id: actorId });
    expect(session.status).toBe(201);
    const message = await turn
      .api()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({ message: JSON.stringify({ calls: ECHO }) });
    expect(message.status).toBe(201);
    const res = await turn
      .api()
      .post(`/api/v1/sessions/${session.body.id}/generate?wait=true`)
      .send({});
    expect(res.status).toBe(200);
    return res.body.generation_id;
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    process.env.TOOL_ASSERTION_PRIVATE_KEY = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'oboidentity' });
    const jwks = await turn.api().get('/.well-known/tool-assertion-jwks.json');
    kid = jwks.body.keys[0].kid;

    mcpPath = `/${turn.unique('mcp')}`;
    turn.target.reply(mcpPath, (body) => {
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'echo' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { body: { jsonrpc: '2.0', id: body.id, result } };
    });
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${mcpPath}` },
    });
    toolId = tool.id;

    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;

    blueDoc = await createDocument({ team: 'blue' });
    redDoc = await createDocument({ team: 'red' });

    const agentsOnly = await createPolicy([
      { effect: 'Allow', action: ['agents:*'] },
    ]);
    const notRedDocuments = await createPolicy([
      {
        effect: 'Allow',
        action: ['documents:*'],
        condition: { StringNotEquals: { 'iam:ResourceTag/team': 'red' } },
      },
    ]);
    const ownDocuments = await createPolicy([
      {
        effect: 'Allow',
        action: ['documents:*'],
        condition: {
          StringEquals: { 'iam:ResourceTag/owner': '${iam:ActorId}' },
        },
      },
    ]);

    const generate = async (agentId: string) => {
      return (await turn.generate({ agentId, calls: ECHO })).id;
    };
    deniedGeneration = await generate(await agentWith([agentsOnly]));
    taggedGeneration = await generate(await agentWith([notRedDocuments]));
    const uncappedAgent = await agentWith();
    uncappedGeneration = await generate(uncappedAgent);

    const narrowKey = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: 'agents only key',
        project_id: turn.projectId,
        policy_ids: [agentsOnly],
      });
    expect(narrowKey.status).toBe(201);
    const narrowRes = await authenticatedTestClient(narrowKey.body.key)
      .post(`/api/v1/agents/${uncappedAgent}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: JSON.stringify({ calls: ECHO }) }],
      });
    expect(narrowRes.status).toBe(200);
    narrowCallerGeneration = narrowRes.body.id;

    const runAsAgent = await turn.createAgent({
      tool_bindings: [{ tool_id: toolId }],
      run_as: 'agent',
      policy_ids: [notRedDocuments],
    });
    const runAsRes = await authenticatedTestClient(narrowKey.body.key)
      .post(`/api/v1/agents/${runAsAgent}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: JSON.stringify({ calls: ECHO }) }],
      });
    expect(runAsRes.status).toBe(200);
    runAsAgentGeneration = runAsRes.body.id;

    const actor = await turn
      .api()
      .post('/api/v1/actors')
      .send({ project_id: turn.projectId, name: 'end user' });
    expect(actor.status).toBe(201);
    actorId = actor.body.id;
    actorDoc = await createDocument({ owner: actorId });
    otherActorDoc = await createDocument({ owner: 'act_someoneelse' });
    actorGeneration = await generationAsActor(await agentWith([ownDocuments]));

    const trigger = await turn
      .api()
      .post('/api/v1/triggers')
      .send({
        project_id: turn.projectId,
        name: turn.unique('trigger'),
        type: 'manual',
        target_type: 'agent',
        target_id: uncappedAgent,
        input: { message: JSON.stringify({ calls: ECHO }) },
        policy_ids: [agentsOnly, notRedDocuments],
      });
    expect(trigger.status).toBe(201);
    const fired = await turn
      .api()
      .post(`/api/v1/triggers/${trigger.body.id}/fire`)
      .send({});
    expect(fired.status).toBe(200);
    triggerGeneration = fired.body.result.result_id;
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  describe('PATCH /api/v1/documents/:document_id', () => {
    test('the key alone writes', async () => {
      const res = await updateDocument({ documentId: blueDoc });

      expect(res.status).toBe(200);
    });

    test("is 403 where the agent's policy_ids deny the action", async () => {
      const res = await updateDocument({
        documentId: blueDoc,
        generationId: deniedGeneration,
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.meta.denied_by).toEqual({
        type: 'generation',
        id: deniedGeneration,
      });
    });

    test('a tag-conditioned policy allows a matching item', async () => {
      const res = await updateDocument({
        documentId: blueDoc,
        generationId: taggedGeneration,
      });

      expect(res.status).toBe(200);
    });

    test('a tag-conditioned policy refuses another item', async () => {
      const res = await updateDocument({
        documentId: redDoc,
        generationId: taggedGeneration,
      });

      expect(res.status).toBe(403);
    });

    test('an agent with no policy_ids leaves the caller and the key', async () => {
      const res = await updateDocument({
        documentId: redDoc,
        generationId: uncappedGeneration,
      });

      expect(res.status).toBe(200);
    });

    test("is 403 where the generation's caller lacks the action", async () => {
      const res = await updateDocument({
        documentId: blueDoc,
        generationId: narrowCallerGeneration,
      });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_by).toEqual({
        type: 'generation',
        id: narrowCallerGeneration,
      });
    });

    test("a run_as: agent generation acts under the agent's policy_ids, not its caller's", async () => {
      const allowed = await updateDocument({
        documentId: blueDoc,
        generationId: runAsAgentGeneration,
      });
      const refused = await updateDocument({
        documentId: redDoc,
        generationId: runAsAgentGeneration,
      });

      expect(allowed.status).toBe(200);
      expect(refused.status).toBe(403);
    });

    test("binds ${iam:ActorId} to the generation's actor", async () => {
      const own = await updateDocument({
        documentId: actorDoc,
        generationId: actorGeneration,
      });
      const other = await updateDocument({
        documentId: otherActorDoc,
        generationId: actorGeneration,
      });

      expect(own.status).toBe(200);
      expect(other.status).toBe(403);
    });

    test("a trigger-fired generation acts under the trigger's policy_ids", async () => {
      const allowed = await updateDocument({
        documentId: blueDoc,
        generationId: triggerGeneration,
      });
      const refused = await updateDocument({
        documentId: redDoc,
        generationId: triggerGeneration,
      });

      expect(allowed.status).toBe(200);
      expect(refused.status).toBe(403);
    });

    test('a generation that does not resolve allows nothing', async () => {
      const res = await updateDocument({
        documentId: blueDoc,
        generationId: 'gen_V1StGXR8Z5jdHi6B',
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('GET /api/v1/documents', () => {
    test('lists only what the agent may read', async () => {
      const res = await authenticatedTestClient(projectKey)
        .get(`/api/v1/documents?project_id=${turn.projectId}`)
        .set(HEADER, assertion(taggedGeneration));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((doc: { id: string }) => {
        return doc.id;
      });
      expect(ids).toContain(blueDoc);
      expect(ids).not.toContain(redDoc);
    });
  });
});
