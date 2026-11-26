import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as pdfModule from 'src/lib/pdf';

import { testGrant } from '../../fixtures/bootstrap';
import { ONE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
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

let answer: (messages: StubMessage[]) => string | Promise<string> = () => {
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
    req.on('end', async () => {
      const body = JSON.parse(raw) as {
        messages: StubMessage[];
        stream?: boolean;
      };
      received.push(body.messages);
      const content = await answer(body.messages);
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

    test('a citing turn that injected nothing rejects every label', async () => {
      const agentId = await create('/api/v1/agents', {
        project_id: projectId,
        ai_provider_id: providerId,
        name: 'cite-no-knowledge',
        citation_config: { enabled: true },
      });
      answer = () => {
        return '<cite ref="c1" quote="dose">x</cite>';
      };

      const body = await generate({ agentId });

      expect(body.output.content).toBe('x');
      expect(body.output.citations).toEqual([]);
      expect(body.output.rejected_citations).toEqual([
        { ref: 'c1', quoted_text: 'dose', reason: 'UNKNOWN_REF' },
      ]);
    });

    test('a memory result carries no label and documents beside it still cite', async () => {
      const memoryStoreId = await create('/api/v1/memory-stores', {
        project_id: projectId,
        name: 'Citation memories',
      });
      await create('/api/v1/memories', {
        memory_store_id: memoryStoreId,
        content: 'O paciente prefere a dose noturna.',
      });
      const agentId = await create('/api/v1/agents', {
        project_id: projectId,
        ai_provider_id: providerId,
        name: 'cite-with-memory',
        knowledge_config: {
          document_paths: ['/protocols/'],
          memory_store_ids: [memoryStoreId],
        },
        citation_config: { enabled: true },
      });
      answer = citePage12({
        quote: 'dose máxima de 40 mg/dia',
        claim: 'O máximo é 40 mg/dia.',
      });
      const before = received.length;

      const body = await generate({ agentId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).toMatch(/\[Memory store: Citation memories \(mem_[^)]+\)\]/);
      expect(body.output.citations).toHaveLength(1);
      expect(body.output.citations[0].page).toBe(12);
    });

    test('a chunk re-chunked before the answer is verified is SOURCE_UNAVAILABLE', async () => {
      const volatileId = await create('/api/v1/documents', {
        project_id: projectId,
        content: 'Volatile dose guidance.',
        path: '/volatile/guide.md',
      });
      const agentId = await create('/api/v1/agents', {
        project_id: projectId,
        ai_provider_id: providerId,
        name: 'cite-volatile',
        knowledge_config: { document_paths: ['/volatile/'] },
        citation_config: { enabled: true },
      });
      answer = async (messages) => {
        const match = JSON.stringify(messages).match(
          /\[Document: \/volatile\/guide\.md (c\d+)\]/
        );
        const edit = await asAdmin()
          .patch(`/api/v1/documents/${volatileId}`)
          .send({ content: 'Rewritten guidance.' });
        expect(edit.status).toBe(200);
        return `<cite ref="${match ? match[1] : 'c0'}" quote="dose">x</cite>`;
      };

      const body = await generate({ agentId });

      expect(body.output.rejected_citations).toEqual([
        {
          ref: expect.stringMatching(/^c\d+$/),
          quoted_text: 'dose',
          reason: 'SOURCE_UNAVAILABLE',
        },
      ]);
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

  describe('conversation and session turns', () => {
    const CITED = {
      origin: 'retrieval',
      page: 12,
      quoted_text: 'dose máxima de 40 mg/dia',
      answer_span: { start: 10, end: 31 },
    };

    const conversationTurn = async (agentId: string) => {
      const conversation = await create('/api/v1/conversations', {
        project_id: projectId,
      });
      await asAdmin()
        .post(`/api/v1/conversations/${conversation}/messages`)
        .send({ role: 'user', message: 'Qual a dose máxima?' });
      const res = await asAdmin()
        .post(`/api/v1/conversations/${conversation}/generate?wait=true`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);
      const listed = await asAdmin().get(
        `/api/v1/conversations/${conversation}/messages`
      );
      expect(listed.status).toBe(200);
      return { generated: res.body, listed: listed.body.data };
    };

    test('the assistant message carries the turn citations, served on the transcript', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = citePage12({
        quote: 'dose máxima de 40 mg/dia',
        claim: 'O máximo é 40 mg/dia.',
      });

      const { generated, listed } = await conversationTurn(agentId);

      expect(generated.message.content).toBe('Resposta: O máximo é 40 mg/dia.');
      expect(generated.message.citations).toEqual([
        expect.objectContaining({ ...CITED, document_id: documentId }),
      ]);
      expect(listed[0].citations).toBeNull();
      expect(listed[1].citations).toEqual(generated.message.citations);
    });

    test('a turn that does not cite stores null', async () => {
      const agentId = await createAgent();
      answer = () => {
        return 'Sem citações.';
      };

      const { generated, listed } = await conversationTurn(agentId);

      expect(generated.message.citations).toBeNull();
      expect(listed[1].citations).toBeNull();
    });

    test('a session turn returns them and a fork keeps them', async () => {
      const agentId = await createAgent({ citationConfig: { enabled: true } });
      answer = citePage12({
        quote: 'dose máxima de 40 mg/dia',
        claim: 'O máximo é 40 mg/dia.',
      });
      const sessionId = await create('/api/v1/sessions', {
        agent_id: agentId,
        auto_generate: true,
      });

      const added = await asAdmin()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ message: 'Qual a dose máxima?' });
      expect(added.status).toBe(201);
      expect(added.body.message.citations).toEqual([
        expect.objectContaining(CITED),
      ]);

      const fork = await asAdmin()
        .post(`/api/v1/sessions/${sessionId}/fork`)
        .send({ fork_at_position: 1 });
      expect(fork.status).toBe(201);
      const listed = await asAdmin().get(
        `/api/v1/conversations/${fork.body.conversation_id}/messages`
      );
      expect(listed.body.data[1].citations).toEqual(
        added.body.message.citations
      );
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate — attached files', () => {
    let readPdfPagesSpy: jest.SpyInstance;

    // unpdf's ESM dynamic imports do not run in Jest's CJS VM; the pages are
    // stubbed and everything after extraction runs for real.
    const PAGES = [
      'Paciente: M. S., 54 anos.',
      'Conduta: solicito hemograma completo e creatinina.',
    ];

    const upload = async (args: {
      filename: string;
      contentType: string;
      buffer?: Buffer;
    }): Promise<string> => {
      const res = await asAdmin()
        .post('/api/v1/files/upload')
        .attach('file', args.buffer ?? ONE_PAGE_PDF_BUFFER, {
          filename: args.filename,
          contentType: args.contentType,
        })
        .field('project_id', projectId);
      expect(res.status).toBe(201);
      return res.body.id;
    };

    const askWith = (args: {
      agentId: string;
      fileId: string;
      citationConfig?: unknown;
    }) => {
      return generate({
        agentId: args.agentId,
        body: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Quais exames este laudo pede?' },
                { type: 'file', file_id: args.fileId },
              ],
            },
          ],
          ...(args.citationConfig === undefined
            ? {}
            : { citation_config: args.citationConfig }),
        },
      });
    };

    const createBareAgent = (citationConfig?: unknown) => {
      return create('/api/v1/agents', {
        project_id: projectId,
        ai_provider_id: providerId,
        name: `cite-file-${Math.random().toString(36).slice(2)}`,
        ...(citationConfig === undefined
          ? {}
          : { citation_config: citationConfig }),
      });
    };

    /** The label the turn gave `page` of the attached file named `filename`. */
    const fileLabel = (args: {
      messages: StubMessage[];
      filename: string;
      page: number | null;
    }): string => {
      const page = args.page === null ? '' : ` \\(page ${args.page}\\)`;
      const match = JSON.stringify(args.messages).match(
        new RegExp(
          `\\[File: ${args.filename.replace('.', '\\.')}${page} (a\\d+)\\]`
        )
      );
      return match ? match[1] : 'a0';
    };

    beforeEach(() => {
      readPdfPagesSpy = jest
        .spyOn(pdfModule, 'readPdfPages')
        .mockResolvedValue(PAGES);
    });

    afterEach(() => {
      readPdfPagesSpy.mockRestore();
    });

    test('a page of an attached PDF is cited by file and page', async () => {
      const fileId = await upload({
        filename: 'laudo.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = (messages) => {
        const ref = fileLabel({ messages, filename: 'laudo.pdf', page: 2 });
        return `<cite ref="${ref}" quote="solicito hemograma completo">Pede hemograma.</cite>`;
      };

      const body = await askWith({ agentId, fileId });
      const record = await readGeneration(body.id);

      expect(body.output.content).toBe('Pede hemograma.');
      expect(body.output.citations).toEqual([
        {
          origin: 'attached_file',
          document_id: null,
          document_version: null,
          chunk_id: null,
          file_id: fileId,
          page: 2,
          page_end: 2,
          quoted_text: 'solicito hemograma completo',
          source_span: { start: 9, end: 36 },
          answer_span: { start: 0, end: 15 },
          verification: 'runtime',
        },
      ]);
      expect(record.citations[0]).toMatchObject({
        origin: 'attached_file',
        file_id: fileId,
        page: 2,
      });
      expect(record.citations[0].quoted_text).toBeUndefined();
    });

    test('a PDF whose pages all read is sent as its text, not the file', async () => {
      const fileId = await upload({
        filename: 'texto.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = () => {
        return 'Done.';
      };
      const before = received.length;

      await askWith({ agentId, fileId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).toMatch(/\[File: texto\.pdf \(page 1\) a\d+\]/);
      expect(sent).toMatch(/\[File: texto\.pdf \(page 2\) a\d+\]/);
      expect(sent).not.toContain('application/pdf');
    });

    test('a page with no text keeps the file in the message, unlabelled', async () => {
      readPdfPagesSpy.mockResolvedValue([PAGES[0], '   ']);
      const fileId = await upload({
        filename: 'scan.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = () => {
        return 'Done.';
      };
      const before = received.length;

      await askWith({ agentId, fileId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).toMatch(/\[File: scan\.pdf \(page 1\) a\d+\]/);
      expect(sent).not.toMatch(/\[File: scan\.pdf \(page 2\)/);
      expect(sent).toContain('application/pdf');
    });

    test('a PDF with no text anywhere is sent as the file, with no labels', async () => {
      readPdfPagesSpy.mockResolvedValue(['', ' ']);
      const fileId = await upload({
        filename: 'allscan.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = () => {
        return 'Done.';
      };
      const before = received.length;

      await askWith({ agentId, fileId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).not.toContain('[File: allscan.pdf');
      expect(sent).toContain('application/pdf');
    });

    test('an unreadable PDF is sent unchanged, with no labels', async () => {
      readPdfPagesSpy.mockResolvedValue(null);
      const fileId = await upload({
        filename: 'broken.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = () => {
        return '<cite ref="a1" quote="x">y</cite>';
      };
      const before = received.length;

      const body = await askWith({ agentId, fileId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).not.toContain('[File: broken.pdf');
      expect(sent).toContain('application/pdf');
      expect(body.output.rejected_citations).toEqual([
        { ref: 'a1', quoted_text: 'x', reason: 'UNKNOWN_REF' },
      ]);
    });

    test('a text file is cited with no page', async () => {
      const fileId = await upload({
        filename: 'nota.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('Retorno em 15 dias.'),
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = (messages) => {
        const ref = fileLabel({ messages, filename: 'nota.txt', page: null });
        return `<cite ref="${ref}" quote="15 dias">Volta em 15 dias.</cite>`;
      };

      const body = await askWith({ agentId, fileId });

      expect(body.output.citations[0]).toMatchObject({
        origin: 'attached_file',
        file_id: fileId,
        page: null,
        page_end: null,
        quoted_text: '15 dias',
      });
    });

    test('a turn that does not cite sends the file as it is', async () => {
      const fileId = await upload({
        filename: 'plain.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent();
      answer = () => {
        return 'Done.';
      };
      const before = received.length;

      const body = await askWith({ agentId, fileId });

      const sent = JSON.stringify(received.slice(before)[0]);
      expect(sent).not.toContain('[File: plain.pdf');
      expect(sent).toContain('application/pdf');
      expect(body.output.citations).toBeUndefined();
    });

    test('a file deleted before the answer is verified is SOURCE_UNAVAILABLE', async () => {
      const fileId = await upload({
        filename: 'gone.pdf',
        contentType: 'application/pdf',
      });
      const agentId = await createBareAgent({ enabled: true });
      answer = async (messages) => {
        const ref = fileLabel({ messages, filename: 'gone.pdf', page: 2 });
        const removed = await asAdmin().delete(`/api/v1/files/${fileId}`);
        expect(removed.status).toBe(204);
        return `<cite ref="${ref}" quote="hemograma">x</cite>`;
      };

      const body = await askWith({ agentId, fileId });

      expect(body.output.rejected_citations).toEqual([
        {
          ref: expect.stringMatching(/^a\d+$/),
          quoted_text: 'hemograma',
          reason: 'SOURCE_UNAVAILABLE',
        },
      ]);
    });
  });
});
