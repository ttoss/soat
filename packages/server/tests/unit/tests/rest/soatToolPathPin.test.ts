import type { Tool } from 'ai';
import { resolveSoatTools } from 'src/lib/agentToolResolverExternalTools';
import { HttpToolError } from 'src/lib/httpToolError';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const UNMETERED = { projectId: 0, toolId: null, workId: null, attribution: {} };

/**
 * A builtin tool presetting `path_prefix` confines the model to one directory:
 * the preset is the route's pin, so whatever `path` the model chooses, the
 * document lands inside it or the call is refused.
 */
describe('a builtin tool presetting path_prefix on create-document', () => {
  let adminToken: string;
  let projectId: string;

  const PIN = '/people/alice/';

  const pinnedTool = (action: string): Tool => {
    const tools = resolveSoatTools({
      meter: UNMETERED,
      typedTool: {
        name: 'notes',
        description: null,
        actions: [action],
        presetParameters: { path_prefix: PIN },
      },
      authHeader: `Bearer ${adminToken}`,
      projectPublicId: projectId,
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: () => {},
    });
    return tools[`notes_${action}`];
  };

  const execute = async (
    input: Record<string, unknown>,
    action = 'create-document'
  ) => {
    return (await pinnedTool(action).execute?.(input, {
      messages: [],
      toolCallId: 'call_1',
      context: undefined,
    })) as { path?: string };
  };

  /** The code the route refused with, off the error the tool throws. */
  const refusalCode = async (input: Record<string, unknown>) => {
    const error = await execute(input).then(
      () => {
        return undefined;
      },
      (error_: unknown) => {
        return error_;
      }
    );
    expect(error).toBeInstanceOf(HttpToolError);
    const { status, body } = error as HttpToolError;
    expect(status).toBe(400);
    return (JSON.parse(body) as { error: { code: string } }).error.code;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'pathpintool',
      policyActions: [
        'documents:CreateDocument',
        'documents:IngestDocument',
        'files:UploadFile',
      ],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  test('creates inside the pin', async () => {
    const result = await execute({
      content: 'mine',
      path: `${PIN}note.txt`,
    });
    expect(result.path).toBe(`${PIN}note.txt`);
  });

  test('cannot create outside the pin', async () => {
    expect(
      await refusalCode({ content: 'theirs', path: '/people/bob/note.txt' })
    ).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
  });

  test('cannot widen the pin with its own path_prefix', async () => {
    expect(
      await refusalCode({
        content: 'theirs',
        path: '/people/bob/widened.txt',
        path_prefix: '/',
      })
    ).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
  });

  test('ingest-document files inside the pin whatever prefix the model asks for', async () => {
    const upload = await authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('ingested'), {
        filename: 'ingested.txt',
        contentType: 'text/plain',
      })
      .field('project_id', projectId);
    expect(upload.status).toBe(201);

    const result = await execute(
      { file_id: upload.body.id, path_prefix: '/people/bob/', wait: true },
      'ingest-document'
    );
    expect(result.path).toBe(`${PIN}ingested.txt`);
  });
});
