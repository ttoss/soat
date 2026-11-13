import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { callTool } from 'src/lib/tools';
import { parseWorkAuthority } from 'src/lib/workAuthority';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Durable work runs under the authority stored on its row: a firing nobody
 * called under its trigger's grant, at every later drive, whoever resumes it;
 * work holding none sends no call.
 */
describe('stored work authority', () => {
  let adminToken: string;
  let projectId: string;
  let listToolId: string;

  const sign = (secret: string, body: string) => {
    return `sha256=${crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')}`;
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

  const pollFiring = async (firingId: string) => {
    for (let i = 0; i < 40; i++) {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/trigger-firings/${firingId}`
      );
      if (['completed', 'failed'].includes(res.body.status)) return res.body;
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    throw new Error('firing did not settle');
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
    /** Fires a webhook trigger at an `ask` → list-tools run, parked on `ask`. */
    const fireParkedRun = async (triggerActions: string[]) => {
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
          type: 'webhook',
          target_type: 'orchestration',
          target_id: orchestration.body.id,
        });
      expect(trigger.status).toBe(201);

      const body = JSON.stringify({});
      const fired = await testClient
        .post(`/hooks/triggers/${trigger.body.id}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(trigger.body.secret, body))
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
  });
});
