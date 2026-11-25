import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { testGrant } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Citations on a real turn over a paged document: the labels the model is
 * given, the markup it answers with, and what the runtime returns and records.
 *
 * The provider is a local chat-completions stub whose answer is built from the
 * request it receives, so a test cites the label the turn actually injected.
 */
type StubMessage = { role: string; content: unknown };

const PAGE_12 = 'A dose máxima de 40 mg/dia não deve ser excedida.';
const PAGE_13 = 'Reduzir para 20 mg/dia se ClCr < 30.';

/** The label the injected block gave the passage from `page`. */
const labelOfPage = (args: {
  messages: StubMessage[];
  page: number;
}): string => {
  const text = JSON.stringify(args.messages);
  const match = text.match(new RegExp(`\\(page ${args.page}\\) (c\\d+)\\]`));
  return match ? match[1] : 'c0';
};

let answer: (messages: StubMessage[]) => string = () => {
  return 'Done.';
};
const received: StubMessage[][] = [];

const writeStream = (res: ServerResponse, content: string): void => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const pieces = [content.slice(0, 9), content.slice(9, 40), content.slice(40)];
  for (const piece of pieces) {
    const chunk = {
      id: 'chatcmpl-cite',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-model',
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  const last = {
    id: 'chatcmpl-cite',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  res.write(`data: ${JSON.stringify(last)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};

const startProvider = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        messages: StubMessage[];
        stream?: boolean;
      };
      received.push(body.messages);
      const content = answer(body.messages);
      if (body.stream) {
        writeStream(res, content);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-cite',
          object: 'chat.completion',
          created: 0,
          model: 'stub-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
};

/** A converter tool answering with the protocol's two numbered pages. */
const startConverter = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          pages: [
            { text: PAGE_12, page_number: 12 },
            { text: PAGE_13, page_number: 13 },
          ],
        })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/convert` };
};

describe('Generation citations', () => {
  let adminToken: string;
  let projectId: string;
  let providerId: string;
  let documentId: string;
  let provider: { server: Server; url: string };
  let converter: { server: Server; url: string };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = (args: { citationConfig?: unknown } = {}) => {
    return create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: `cite-${Math.random().toString(36).slice(2)}`,
      knowledge_config: { document_paths: ['/protocols/'] },
      ...(args.citationConfig === undefined
        ? {}
        : { citation_config: args.citationConfig }),
    });
  };

  const generate = async (args: {
    agentId: string;
    body?: Record<string, unknown>;
  }) => {
    const res = await asAdmin()
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'Qual a dose máxima?' }],
        ...args.body,
      });
    expect(res.status).toBe(200);
    return res.body;
  };

  const readGeneration = async (generationId: string) => {
    const res = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const citePage12 = (args: { quote: string; claim: string }) => {
    return (messages: StubMessage[]) => {
      const ref = labelOfPage({ messages, page: 12 });
      return `Resposta: <cite ref="${ref}" quote="${args.quote}">${args.claim}</cite>`;
    };
  };

  beforeAll(async () => {
    provider = await startProvider();
    converter = await startConverter();
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'citationsadmin', password: 'supersecret' });
    adminToken = await loginAs('citationsadmin', 'supersecret');

    projectId = await create('/api/v1/projects', { name: 'Citations' });
    providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'Citations provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: provider.url,
    });
    const converterId = await create('/api/v1/tools', {
      project_id: projectId,
      name: 'protocol-converter',
      type: 'http',
      execute: { url: converter.url, method: 'POST' },
    });
    await create('/api/v1/ingestion-rules', {
      policy_ids: await testGrant({ token: adminToken }),
      project_id: projectId,
      content_type_glob: 'application/x-protocol',
      tool_id: converterId,
      chunk_strategy: 'page',
    });
    const fileRes = await asAdmin()
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('protocol bytes'), {
        filename: 'protocol.pdf',
        contentType: 'application/x-protocol',
      })
      .field('project_id', projectId);
    expect(fileRes.status).toBe(201);
    const ingest = await asAdmin()
      .post('/api/v1/documents/ingest?wait=true')
      .send({
        project_id: projectId,
        file_id: fileRes.body.id,
        path_prefix: '/protocols/',
      });
    expect(ingest.body.status).toBe('ready');
    documentId = ingest.body.id;
  });

  afterAll(async () => {
    for (const { server } of [provider, converter]) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  describe('POST /api/v1/agents', () => {
    test('stores and returns citation_config', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      const res = await asAdmin().get(`/api/v1/agents/${agentId}`);
      expect(res.status).toBe(200);
      expect(res.body.citation_config).toEqual({ enabled: true });
    });

    test('an unknown citation_config key is 400', async () => {
      const res = await asAdmin()
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: providerId,
          name: 'cite-typo',
          citation_config: { enable: true },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-boolean enabled is 400', async () => {
      const res = await asAdmin()
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: providerId,
          name: 'cite-string',
          citation_config: { enabled: 'yes' },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('a verbatim quote is returned with its document, page and spans', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = citePage12({
        quote: 'dose máxima de 40 mg/dia',
        claim: 'O máximo é 40 mg/dia.',
      });

      const body = await generate({ agentId });

      expect(body.output.content).toBe('Resposta: O máximo é 40 mg/dia.');
      expect(body.output.citations).toEqual([
        {
          origin: 'retrieval',
          document_id: documentId,
          document_version: 1,
          chunk_id: expect.stringMatching(/^dchunk_/),
          file_id: null,
          page: 12,
          page_end: 12,
          quoted_text: 'dose máxima de 40 mg/dia',
          source_span: { start: 2, end: 26 },
          answer_span: { start: 10, end: 31 },
          verification: 'runtime',
        },
      ]);
      expect(body.output.rejected_citations).toEqual([]);
      expect(Array.from(PAGE_12).slice(2, 26).join('')).toBe(
        body.output.citations[0].quoted_text
      );
    });

    test('the injected passages carry their labels and the model is told how to cite', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = () => {
        return 'Done.';
      };
      const before = received.length;

      await generate({ agentId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).toMatch(/\(page 12\) c\d+\]/);
      expect(sent).toMatch(/\(page 13\) c\d+\]/);
      expect(sent).toContain('<cite ref=');
    });

    test('a quote the page does not contain is rejected, never returned', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = citePage12({
        quote: 'dose máxima de 80 mg/dia',
        claim: 'O máximo é 80 mg/dia.',
      });

      const body = await generate({ agentId });

      expect(body.output.content).toBe('Resposta: O máximo é 80 mg/dia.');
      expect(body.output.citations).toEqual([]);
      expect(body.output.rejected_citations).toEqual([
        {
          ref: expect.stringMatching(/^c\d+$/),
          quoted_text: 'dose máxima de 80 mg/dia',
          reason: 'QUOTE_NOT_FOUND',
        },
      ]);
    });

    test('a label the turn never injected is rejected', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = () => {
        return '<cite ref="c99" quote="dose">x</cite>';
      };

      const body = await generate({ agentId });

      expect(body.output.rejected_citations).toEqual([
        { ref: 'c99', quoted_text: 'dose', reason: 'UNKNOWN_REF' },
      ]);
    });

    test('the generation record keeps pointers, never the quoted text', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = citePage12({
        quote: 'não deve ser excedida',
        claim: 'Não exceda.',
      });

      const body = await generate({ agentId });
      const record = await readGeneration(body.id);

      expect(record.citations).toEqual([
        {
          origin: 'retrieval',
          document_id: body.output.citations[0].document_id,
          document_version: body.output.citations[0].document_version,
          chunk_id: body.output.citations[0].chunk_id,
          file_id: null,
          page: 12,
          page_end: 12,
          source_span: body.output.citations[0].source_span,
          answer_span: body.output.citations[0].answer_span,
          verification: 'runtime',
        },
      ]);
    });

    test('an agent without citation_config returns the text as written', async () => {
      const agentId = await createAgent();
      const raw = '<cite ref="c1" quote="dose">x</cite>';
      answer = () => {
        return raw;
      };
      const before = received.length;

      const body = await generate({ agentId });
      const record = await readGeneration(body.id);

      expect(body.output.content).toBe(raw);
      expect(body.output.citations).toBeUndefined();
      expect(body.output.rejected_citations).toBeUndefined();
      expect(record.citations).toBeNull();
      expect(JSON.stringify(received.slice(before)[0])).not.toMatch(
        /\(page 12\) c\d+\]/
      );
    });

    test('a request citation_config turns citations on for one turn', async () => {
      const agentId = await createAgent();
      answer = citePage12({ quote: 'Posologia', claim: 'x' });

      const body = await generate({
        agentId,
        body: { citation_config: { enabled: true } },
      });

      expect(body.output.citations).toEqual([]);
      expect(body.output.rejected_citations[0].reason).toBe('QUOTE_NOT_FOUND');
    });

    test('a request citation_config turns them off over the agent', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = () => {
        return 'Plain.';
      };

      const body = await generate({
        agentId,
        body: { citation_config: { enabled: false } },
      });

      expect(body.output.citations).toBeUndefined();
    });

    test('an unknown request citation_config key is 400', async () => {
      const agentId = await createAgent();
      const res = await asAdmin()
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'Qual a dose máxima?' }],
          citation_config: { on: true },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a stream carries no markup and ends with the verified citations', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = citePage12({
        quote: 'dose máxima de 40 mg/dia',
        claim: 'O máximo é 40 mg/dia.',
      });

      const res = await asAdmin()
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Qual a dose máxima?' }],
          stream: true,
        });

      expect(res.status).toBe(200);
      const deltas = res.text
        .split('\n\n')
        .filter((frame) => {
          return frame.startsWith('data: {"choices"');
        })
        .map((frame) => {
          return JSON.parse(frame.slice('data: '.length)).choices[0].delta
            .content as string;
        })
        .join('');
      expect(deltas).toBe('Resposta: O máximo é 40 mg/dia.');
      const citationsFrame = res.text.split('\n\n').find((frame) => {
        return frame.startsWith('event: citations');
      });
      expect(citationsFrame).toBeDefined();
      const data = JSON.parse(
        (citationsFrame ?? '')
          .split('\n')
          .find((line) => {
            return line.startsWith('data: ');
          })!
          .slice('data: '.length)
      );
      expect(data.citations[0]).toMatchObject({
        page: 12,
        quoted_text: 'dose máxima de 40 mg/dia',
      });
      expect(data.rejected_citations).toEqual([]);
    });
  });
});
