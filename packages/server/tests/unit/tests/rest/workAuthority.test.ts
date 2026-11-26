import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { dispatchApiRequest } from 'src/lib/inProcessApi';
import { callTool } from 'src/lib/tools';
import { parseWorkAuthority, type WorkAuthority } from 'src/lib/workAuthority';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { pollFor } from '../../fixtures/poll';
import {
  authenticatedTestClient,
  testClient,
  workAuthorityOf,
} from '../../testClient';

/**
 * Durable work runs under the authority stored on its row: a firing nobody
 * called under its trigger's grant, at every later drive, whoever resumes it;
 * work holding none sends no call.
 */
describe('stored work authority', () => {
  let adminToken: string;
  let projectId: string;
  let listToolId: string;

  const sign = (args: { secret: string; body: string }) => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto
      .createHmac('sha256', args.secret)
      .update(`${t}.${args.body}`)
      .digest('hex');
    return `t=${t},v1=${v1}`;
  };

  const policyAllowing = async (name: string, actions: string[]) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        name,
        document: { statement: [{ effect: 'Allow', action: actions }] },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const pollFiring = (firingId: string) => {
    return pollFor({
      read: async () => {
        const res = await authenticatedTestClient(adminToken).get(
          `/api/v1/trigger-firings/${firingId}`
        );
        return res.body;
      },
      pick: (body) => {
        return ['completed', 'failed'].includes(body.status) ? body : undefined;
      },
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'workauthority',
      policyActions: ['tools:ListTools'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const tool = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'workauthority-list-tools',
        type: 'builtin',
        actions: ['list-tools'],
      });
    expect(tool.status).toBe(201);
    listToolId = tool.body.id;
  });

  describe('a trigger-started orchestration run resumed by an admin', () => {
    /** Fires a trigger at an `ask` → list-tools run, parked on `ask`. */
    const fireParkedRun = async (
      triggerActions: string[],
      type: 'webhook' | 'manual' = 'webhook'
    ) => {
      const name = `workauthority-${Math.random().toString(36).slice(2, 8)}`;
      const orchestration = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name,
          nodes: [
            { id: 'ask', type: 'human', prompt: 'Go?' },
            {
              id: 'list',
              type: 'tool',
              tool_id: listToolId,
              operation_id: 'list-tools',
              input_mapping: { project_id: projectId },
            },
          ],
          edges: [{ from: 'ask', to: 'list' }],
        });
      expect(orchestration.status).toBe(201);

      const trigger = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          policy_ids: [await policyAllowing(name, triggerActions)],
          project_id: projectId,
          name,
          type,
          target_type: 'orchestration',
          target_id: orchestration.body.id,
        });
      expect(trigger.status).toBe(201);

      if (type === 'manual') {
        const fired = await authenticatedTestClient(adminToken)
          .post(`/api/v1/triggers/${trigger.body.id}/fire`)
          .send({});
        expect(fired.status).toBe(200);
        expect(fired.body.result.status).toBe('awaiting_input');
        return {
          runId: fired.body.result.result_id as string,
          trigger: trigger.body,
        };
      }
      const body = JSON.stringify({});
      const fired = await testClient
        .post(`/hooks/triggers/${trigger.body.id}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign({ secret: trigger.body.secret, body }))
        .send(body);
      expect(fired.status).toBe(202);
      const firing = await pollFiring(fired.body.firing_id);
      expect(firing.result.status).toBe('awaiting_input');
      return {
        runId: firing.result.result_id as string,
        trigger: trigger.body,
      };
    };

    const resumeAsAdmin = (runId: string) => {
      return authenticatedTestClient(adminToken)
        .post(`/api/v1/orchestration-runs/${runId}/human-input`)
        .send({ node_id: 'ask', output: {} });
    };

    test('stores the trigger grant on the run', async () => {
      const { runId, trigger } = await fireParkedRun([
        'orchestrations:StartRun',
        'tools:CallTool',
        'tools:ListTools',
      ]);
      const run = await db.OrchestrationRun.findOne({
        where: { publicId: runId },
      });
      expect(parseWorkAuthority(run!.authority)).toMatchObject({
        grant: { holder: 'trigger', trigger: trigger.id },
        principal: { type: 'trigger', id: trigger.id },
        trigger: trigger.id,
      });
    });

    test('runs the resumed segment under the trigger grant', async () => {
      const { runId } = await fireParkedRun([
        'orchestrations:StartRun',
        'tools:CallTool',
        'tools:ListTools',
      ]);
      const res = await resumeAsAdmin(runId);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    test('holds a manual fire to its caller as well as the trigger grant', async () => {
      const { runId, trigger } = await fireParkedRun(
        ['orchestrations:StartRun', 'tools:CallTool', 'tools:ListTools'],
        'manual'
      );
      const me =
        await authenticatedTestClient(adminToken).get('/api/v1/users/me');

      const res = await resumeAsAdmin(runId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const run = await db.OrchestrationRun.findOne({
        where: { publicId: runId },
      });
      expect(parseWorkAuthority(run!.authority)).toMatchObject({
        grant: { holder: 'trigger', trigger: trigger.id },
        caps: [{ kind: 'grant', grant: { holder: 'user', user: me.body.id } }],
      });
    });

    test('does not borrow the resuming admin authority', async () => {
      const { runId } = await fireParkedRun([
        'orchestrations:StartRun',
        'tools:CallTool',
      ]);
      const res = await resumeAsAdmin(runId);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('work holding no authority', () => {
    let hits = 0;
    let server: http.Server;
    let httpToolId: string;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        hits += 1;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const { port } = server.address() as AddressInfo;
      const tool = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'workauthority-http',
          type: 'http',
          execute: { url: `http://127.0.0.1:${port}/`, method: 'POST' },
        });
      expect(tool.status).toBe(201);
      httpToolId = tool.body.id;
    });

    afterAll(async () => {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    });

    test('sends no http tool call', async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      await expect(
        callTool({
          attribution: {},
          guardrails: 'apply',
          projectId: project!.id as number,
          reach: 'project',
          id: httpToolId,
          input: {},
          authority: null,
        })
      ).rejects.toMatchObject({ code: 'WORK_AUTHORITY_MISSING' });
      expect(hits).toBe(0);
    });

    /** Work whose stored authority names a user that no longer exists. */
    const goneUserAuthority = () => {
      return workAuthorityOf({
        project: projectId,
        user: 'usr_gonegonegone00',
      });
    };

    const callAs = async (args: {
      id: string;
      action?: string;
      authority: WorkAuthority | null;
    }) => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      return callTool({
        attribution: {},
        guardrails: 'apply',
        projectId: project!.id as number,
        reach: 'project',
        id: args.id,
        action: args.action,
        input: {},
        authority: args.authority,
      });
    };

    test('an in-process call it makes is refused, not served unauthenticated', async () => {
      await expect(
        dispatchApiRequest({
          method: 'GET',
          path: '/api/v1/tools',
          as: { authority: null, actor: null },
        })
      ).rejects.toMatchObject({ code: 'WORK_AUTHORITY_MISSING' });
    });

    test('a builtin call under an authority that no longer resolves answers WORK_AUTHORITY_MISSING', async () => {
      await expect(
        callAs({
          id: listToolId,
          action: 'list-tools',
          authority: goneUserAuthority(),
        })
      ).rejects.toMatchObject({
        code: 'WORK_AUTHORITY_MISSING',
        httpStatus: 409,
      });
    });

    test('a gated call under an authority that no longer resolves answers WORK_AUTHORITY_MISSING', async () => {
      await expect(
        callAs({ id: httpToolId, authority: goneUserAuthority() })
      ).rejects.toMatchObject({ code: 'WORK_AUTHORITY_MISSING' });
      expect(hits).toBe(0);
    });
  });
});
