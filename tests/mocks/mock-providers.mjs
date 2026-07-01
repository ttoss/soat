#!/usr/bin/env node
// Deterministic mock provider endpoints for the `ingest-images-and-audio`
// tutorial, so the converter flow can be validated in the tutorials runner
// without external API keys.
//
// Serves two shapes:
//   POST /v1/chat/completions  — OpenAI-compatible; used by the vision *agent*
//                                converter (the AI provider's base_url points here).
//                                Returns canned OCR text. Supports streaming (SSE)
//                                and non-streaming, keyed on the request's `stream`.
//   POST /v1/listen            — Deepgram-compatible; used by the audio *http tool*
//                                converter. Returns a canned transcript.
//   GET  /health               — readiness probe for docker-compose.
//
// NOTE: the exact OpenAI wire protocol the server uses for agent generation
// (chat/completions vs responses API, streaming or not) is defined by the
// server's LLM client. This mock covers chat/completions in both modes; if the
// converter path (PRD Phase 3) uses a different endpoint, extend the routes here.

import http from 'node:http';

const PORT = Number(process.env.PORT || 8090);

// Canned content — kept searchable so the tutorial's knowledge query hits.
const OCR_TEXT =
  'Receipt — Corner Cafe\nCoffee 3.50\nSandwich 8.00\nTotal amount: 11.50';
const TRANSCRIPT_TEXT =
  'Thanks everyone for joining. The launch is scheduled for next Tuesday and the budget was approved.';

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // OpenAI-compatible chat completions (vision OCR agent converter).
  if (req.method === 'POST' && pathname.endsWith('/chat/completions')) {
    const body = await readBody(req);
    const model = body.model || 'mock-vision';

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const chunk = (delta, finishReason) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          created: 0,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant' }, null));
      res.write(chunk({ content: OCR_TEXT }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: OCR_TEXT },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    );
    return;
  }

  // Deepgram-compatible pre-recorded transcription (audio http tool converter).
  if (req.method === 'POST' && pathname.endsWith('/listen')) {
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        results: {
          channels: [
            {
              alternatives: [{ transcript: TRANSCRIPT_TEXT, confidence: 0.99 }],
            },
          ],
        },
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', method: req.method, pathname }));
});

server.listen(PORT, () => {
  process.stdout.write(`mock-providers listening on :${PORT}\n`);
});
