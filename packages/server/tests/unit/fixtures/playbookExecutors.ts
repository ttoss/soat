import { authenticatedTestClient } from '../testClient';

const created = (res: { status: number; body: { id?: string } }): string => {
  if (res.status !== 201 || typeof res.body.id !== 'string') {
    throw new Error(`Expected 201, got ${res.status}`);
  }
  return res.body.id;
};

/**
 * An http tool a playbook node can name as its executor or transformation;
 * a write refuses an executor the project does not hold.
 */
export const createPlaybookTool = async (args: {
  token: string;
  projectId: string;
  name: string;
  url?: string;
}): Promise<string> => {
  return created(
    await authenticatedTestClient(args.token)
      .post('/api/v1/tools')
      .send({
        project_id: args.projectId,
        name: args.name,
        type: 'http',
        description: 'A tool a playbook node names',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: args.url ?? 'http://127.0.0.1:9/never',
          method: 'POST',
        },
      })
  );
};

/** A decider a playbook node can name, answering through `toolId`. */
export const createPlaybookDecider = async (args: {
  token: string;
  projectId: string;
  name: string;
  toolId: string;
}): Promise<string> => {
  return created(
    await authenticatedTestClient(args.token)
      .post('/api/v1/deciders')
      .send({
        project_id: args.projectId,
        name: args.name,
        tool_id: args.toolId,
        questions: [
          { type: 'predicate', name: 'escalate', instructions: 'Escalate?' },
        ],
      })
  );
};
