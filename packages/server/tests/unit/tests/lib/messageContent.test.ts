import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { createDocument } from 'src/lib/documents';
import { buildSrn } from 'src/lib/iam';
import { resolveMessageContent } from 'src/lib/messageContent';
import { createTool } from 'src/lib/tools';

// These tests drive the real `resolveMessageContent` seam against the real
// database and a real local HTTP server — no `src/**` module mocks. Documents
// and tools are created through their real lib functions; the tool_output HTTP
// call goes over the wire to a stub server so real serialization and
// output-path resolution run. `authUser` is a plain test double passed as an
// argument (dependency injection, not a module mock): its `isAllowed` records
// the permission-argument shape the seam constructs.

const createAuthUser = (overrides?: {
  isAllowed?: jest.Mock<
    Promise<boolean>,
    [
      {
        projectPublicId: string;
        action: string;
        resource?: string;
        resources?: string[];
        context?: Record<string, string>;
      },
    ]
  >;
}) => {
  return {
    id: 1,
    publicId: 'user_123',
    username: 'tester',
    role: 'user' as const,
    isAllowed: overrides?.isAllowed ?? jest.fn().mockResolvedValue(true),
    resolveProjectIds: jest.fn(),
    getPolicies: jest.fn(),
  };
};

let projectId: number;
let projectPublicId: string;
let server: Server;
let baseUrl: string;
let audioToolId: string;
let counterToolId: string;
let listToolId: string;
let soatToolId: string;

describe('resolveMessageContent', () => {
  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'MessageContent Lib Test',
    });
    projectId = project.id as number;
    projectPublicId = project.publicId;

    // Stub HTTP endpoint the http tools point at; routes by path so each tool
    // returns the shape its test asserts on.
    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.startsWith('/audio')) {
        res.end(
          JSON.stringify({
            data: { transcription: { text: 'hello from audio' } },
          })
        );
      } else if (req.url?.startsWith('/counter')) {
        res.end(JSON.stringify({ data: { count: 42 } }));
      } else if (req.url?.startsWith('/list')) {
        res.end(
          JSON.stringify({ data: { items: ['first', 'second', 'third'] } })
        );
      } else {
        res.end(JSON.stringify({ data: {} }));
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const httpParams = { type: 'object', properties: {} };
    const audio = await createTool({
      projectId,
      name: 'audio-to-text',
      type: 'http',
      description: 'Audio to text',
      parameters: httpParams,
      execute: { url: `${baseUrl}/audio`, method: 'POST' },
    });
    audioToolId = audio.id;

    const counter = await createTool({
      projectId,
      name: 'counter',
      type: 'http',
      description: 'Counter',
      parameters: httpParams,
      execute: { url: `${baseUrl}/counter`, method: 'POST' },
    });
    counterToolId = counter.id;

    const list = await createTool({
      projectId,
      name: 'list',
      type: 'http',
      description: 'List',
      parameters: httpParams,
      execute: { url: `${baseUrl}/list`, method: 'POST' },
    });
    listToolId = list.id;

    const soat = await createTool({
      projectId,
      name: 'soat-tool',
      type: 'soat',
      description: 'SOAT tool',
      actions: ['list-tools'],
    });
    soatToolId = soat.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns plain string content unchanged', async () => {
    const result = await resolveMessageContent({ content: 'hello' });

    expect(result).toEqual({ content: 'hello' });
  });

  test('resolves document content', async () => {
    const doc = await createDocument({
      projectId,
      content: 'document content',
      path: '/docs/spec.md',
      tags: { environment: 'test' },
    });
    const authUser = createAuthUser();

    const result = await resolveMessageContent({
      authUser,
      content: { type: 'document', documentId: doc.id },
    });

    expect(result).toEqual({
      content: 'document content',
      documentId: doc.id,
    });
    expect(authUser.isAllowed).toHaveBeenCalledWith({
      projectPublicId,
      action: 'documents:GetDocument',
      resources: [
        buildSrn({
          projectPublicId,
          resourceType: 'document',
          resourceId: doc.id,
        }),
        buildSrn({
          projectPublicId,
          resourceType: 'document',
          resourceId: '/docs/spec.md',
        }),
      ],
      context: {
        'soat:ResourceType': 'document',
        'soat:ResourceTag/environment': 'test',
      },
    });
  });

  test('resolves tool_output content with outputPath', async () => {
    const authUser = createAuthUser();

    const result = await resolveMessageContent({
      projectIds: [projectId],
      authHeader: 'Bearer token',
      authUser,
      allowedToolIds: [audioToolId],
      content: {
        type: 'tool_output',
        toolId: audioToolId,
        input: { url: 'https://example.com/audio.mp3' },
        outputPath: 'data.transcription.text',
      },
    });

    expect(result).toEqual({ content: 'hello from audio' });
    expect(authUser.isAllowed).toHaveBeenCalledWith({
      projectPublicId,
      action: 'tools:CallTool',
    });
  });

  test('stringifies a non-string outputPath result via JSON.stringify', async () => {
    const result = await resolveMessageContent({
      projectIds: [projectId],
      authHeader: 'Bearer token',
      authUser: createAuthUser(),
      allowedToolIds: [counterToolId],
      content: {
        type: 'tool_output',
        toolId: counterToolId,
        input: {},
        outputPath: 'data.count',
      },
    });

    expect(result).toEqual({ content: '42' });
  });

  test('resolves an outputPath that indexes into an array', async () => {
    const result = await resolveMessageContent({
      projectIds: [projectId],
      authHeader: 'Bearer token',
      authUser: createAuthUser(),
      allowedToolIds: [listToolId],
      content: {
        type: 'tool_output',
        toolId: listToolId,
        input: {},
        outputPath: 'data.items.1',
      },
    });

    expect(result).toEqual({ content: 'second' });
  });

  test('rejects document content when caller lacks document permission', async () => {
    const doc = await createDocument({
      projectId,
      content: 'restricted',
      path: '/docs/restricted.md',
    });
    const authUser = createAuthUser({
      isAllowed: jest.fn().mockResolvedValue(false),
    });

    await expect(
      resolveMessageContent({
        authUser,
        content: { type: 'document', documentId: doc.id },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects document content when agent boundary denies document access', async () => {
    const doc = await createDocument({
      projectId,
      content: 'boundary-blocked',
      path: '/docs/boundary.md',
    });
    const authUser = createAuthUser();

    await expect(
      resolveMessageContent({
        authUser,
        agentBoundaryPolicy: {
          statement: [
            {
              effect: 'Allow',
              action: ['tools:CallTool'],
              resource: ['*'],
            },
          ],
        },
        content: { type: 'document', documentId: doc.id },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects tool_output content when tool is not allowed for the agent', async () => {
    const authUser = createAuthUser();

    await expect(
      resolveMessageContent({
        projectIds: [projectId],
        authUser,
        allowedToolIds: ['tool_other'],
        content: {
          type: 'tool_output',
          toolId: audioToolId,
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects tool_output content when caller lacks tool call permission', async () => {
    const authUser = createAuthUser({
      isAllowed: jest.fn().mockResolvedValue(false),
    });

    await expect(
      resolveMessageContent({
        projectIds: [projectId],
        authUser,
        allowedToolIds: [audioToolId],
        content: {
          type: 'tool_output',
          toolId: audioToolId,
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects soat tool_output content when agent boundary denies the action', async () => {
    const authUser = createAuthUser();

    await expect(
      resolveMessageContent({
        projectIds: [projectId],
        authUser,
        allowedToolIds: [soatToolId],
        agentBoundaryPolicy: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:GetDocument'],
              resource: ['*'],
            },
          ],
        },
        content: {
          type: 'tool_output',
          toolId: soatToolId,
          action: 'list-tools',
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
