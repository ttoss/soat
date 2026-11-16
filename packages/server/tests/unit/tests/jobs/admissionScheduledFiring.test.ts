import { fireDueTriggers } from 'src/lib/triggerScheduler';

import {
  type AdmissionService,
  REFUSAL,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

const HOUR_MS = 60 * 60 * 1000;

/**
 * A start is asked where a caller starts the work; a scheduled firing is the
 * trigger's own work, admitted when the trigger was written, so the tick never
 * asks.
 */
describe('admission — a scheduled firing', () => {
  let service: AdmissionService;
  let turn: AgentToolTurn;

  const settledFiring = async (triggerId: string) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const res = await turn
        .api()
        .get(`/api/v1/trigger-firings?trigger_id=${triggerId}`);
      const [firing] = res.body.data;
      if (firing && ['completed', 'failed'].includes(firing.status)) {
        return firing;
      }
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`trigger ${triggerId} never fired`);
  };

  beforeAll(async () => {
    service = await startAdmissionService();
    turn = await startAgentToolTurn({ prefix: 'admitsched' });
  });

  afterAll(async () => {
    service.undeclare();
    await turn.close();
    await service.close();
  });

  test('starts the generation without asking', async () => {
    const agentId = await turn.createAgent({});
    const policy = await turn.createPolicy({
      statement: [
        { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
      ],
    });
    const trigger = await turn
      .api()
      .post('/api/v1/triggers')
      .send({
        project_id: turn.projectId,
        name: 'nightly',
        type: 'schedule',
        target_type: 'agent',
        target_id: agentId,
        policy_ids: [policy],
        cron: '0 8 * * *',
        input: { message: 'good morning' },
      });
    expect(trigger.status).toBe(201);
    service.declare({ actions: ['agents:CreateAgentGeneration'] });
    service.reply = REFUSAL;

    await fireDueTriggers({
      now: new Date(new Date(trigger.body.next_fire_at).getTime() + HOUR_MS),
    });

    const firing = await settledFiring(trigger.body.id);
    expect(firing.status).toBe('completed');
    expect(service.asked).toHaveLength(0);
  });
});
