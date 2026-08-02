import { db } from 'src/db';
import { resolveToolIdsToNames } from 'src/lib/agents';

// `resolveToolIdsToNames` is the id->name lookup `buildPrepareStep` uses to
// translate a step rule's persisted `active_tool_ids` into the tool names the
// AI SDK's `activeTools` option expects (#809). The generation-flow tests
// (`agentGenerationHelpers.test.ts`, `agentNonStreamGeneration.test.ts`) stub
// this function out to avoid a DB round trip per prepareStep case, so it is
// exercised for real here: a thin DB query with a small input space.

describe('resolveToolIdsToNames', () => {
  let projectId: number;
  let otherProjectId: number;
  let toolAId: string;
  let toolBId: string;
  let otherProjectToolId: string;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Tool Id Resolution' });
    projectId = project.id;

    const otherProject = await db.Project.create({
      name: 'Tool Id Resolution — Other',
    });
    otherProjectId = otherProject.id;

    const toolA = await db.Tool.create({
      projectId,
      type: 'client',
      name: 'read_local_file',
      description: 'Read a file on the caller machine',
      parameters: { type: 'object', properties: {} },
    });
    toolAId = toolA.publicId;

    const toolB = await db.Tool.create({
      projectId,
      type: 'client',
      name: 'write_local_file',
      description: 'Write a file on the caller machine',
      parameters: { type: 'object', properties: {} },
    });
    toolBId = toolB.publicId;

    const otherProjectTool = await db.Tool.create({
      projectId: otherProjectId,
      type: 'client',
      name: 'other_project_tool',
      description: 'Belongs to a different project',
      parameters: { type: 'object', properties: {} },
    });
    otherProjectToolId = otherProjectTool.publicId;
  });

  test('returns an empty map for an empty id list without querying the DB', async () => {
    expect(await resolveToolIdsToNames({ toolIds: [], projectId })).toEqual({});
  });

  test('resolves known tool ids to their names', async () => {
    const map = await resolveToolIdsToNames({
      toolIds: [toolAId, toolBId],
      projectId,
    });
    expect(map).toEqual({
      [toolAId]: 'read_local_file',
      [toolBId]: 'write_local_file',
    });
  });

  test('drops an id that names no tool in the project rather than throwing', async () => {
    const map = await resolveToolIdsToNames({
      toolIds: [toolAId, 'tool_doesNotExist9999'],
      projectId,
    });
    expect(map).toEqual({ [toolAId]: 'read_local_file' });
  });

  test('scopes the lookup to the given project, dropping a tool id from another project', async () => {
    const map = await resolveToolIdsToNames({
      toolIds: [toolAId, otherProjectToolId],
      projectId,
    });
    expect(map).toEqual({ [toolAId]: 'read_local_file' });
  });
});
