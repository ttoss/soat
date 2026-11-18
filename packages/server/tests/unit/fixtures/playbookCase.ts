import { flushPlaybookExecutions } from 'src/lib/playbookCascade';
import type { Response, Test } from 'supertest';

/**
 * `POST /playbooks/{id}/cases`, answered once the cascade the case starts in
 * the background has settled: a write racing that run supersedes it. With
 * `createPlaybookCaseOverMcp`, the only case-creation path a test takes
 * (`tests/harness/playbookCaseFixture.test.mjs`).
 */
export const createPlaybookCase = async (args: {
  client: { post: (url: string) => Test };
  playbookId: string;
  body: Record<string, unknown>;
}): Promise<Response> => {
  const res = await args.client
    .post(`/api/v1/playbooks/${args.playbookId}/cases`)
    .send(args.body);
  await flushPlaybookExecutions();
  return res;
};

/** The MCP tool `create-playbook-case`, answered once its cascade has settled. */
export const createPlaybookCaseOverMcp = async (args: {
  call: (toolName: string, toolArgs: Record<string, unknown>) => Test;
  body: Record<string, unknown>;
}): Promise<Response> => {
  const res = await args.call('create-playbook-case', args.body);
  await flushPlaybookExecutions();
  return res;
};
