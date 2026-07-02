#!/usr/bin/env node
// Deterministic mock provider endpoints for the `ingest-images-and-audio`
// tutorial, so the converter flow can be validated in the tutorials runner
// without external API keys.
//
// Both converters are agents on the same OpenAI account, registered with two
// different provider slugs so they use two different wire protocols:
//   * the image OCR agent → native `openai` provider → Responses API
//   * the audio agent      → `custom` provider (base_url pointed at OpenAI
//                            itself) → Chat Completions API
//
// The audio agent must use the `custom` slug: SOAT's native `openai` slug talks
// to the Responses API, whose @ai-sdk/openai converter does not support audio
// input at all (throws `AI_UnsupportedFunctionalityError`), while the Chat
// Completions API converter does (via `input_audio`). See "Ingestion Rules —
// Converter (tool or agent)" in the module docs for the full explanation.
//
// So the mock answers both OpenAI wire protocols:
//   POST /v1/responses         — Responses API (native OpenAI provider). Used by
//                                the vision OCR agent; returns canned OCR text.
//   POST /v1/chat/completions  — Chat Completions API (OpenAI-compatible custom
//                                provider). Used by the audio agent; returns
//                                a canned transcript when the request carries
//                                audio, else canned OCR text. Supports streaming
//                                (SSE) and non-streaming, keyed on `stream`.
//   GET  /health               — readiness probe for docker-compose.
//
// The wire protocol a provider uses is decided by the server's LLM client
// (@ai-sdk/openai): the native `openai` provider calls the Responses API, while
// the `custom` OpenAI-compatible provider calls Chat Completions.

import http from 'node:http';

const PORT = Number(process.env.PORT || 8090);

// Canned content — kept searchable so the tutorial's knowledge queries hit.
const OCR_TEXT =
  'Receipt — Corner Cafe\nCoffee 3.50\nSandwich 8.00\nTotal amount: 11.50';
const TRANSCRIPT_TEXT =
  'Thanks everyone for joining. The launch is scheduled for next Tuesday and the budget was approved.';

const readRaw = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });

const parseJson = (raw) => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

// Decide the modality from the raw request body. An audio request carries an
// `input_audio` part (Chat Completions / Responses) or a file part with an
// `audio/*` media type (the AI SDK's representation of an audio file). Scanning
// the raw JSON keeps this robust across both wire protocols.
const isAudioRequest = (raw) =>
  /"input_audio"/.test(raw) || /"(?:media_?type|type)"\s*:\s*"audio\//.test(raw);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Responses API (native OpenAI provider) — the vision OCR agent lands here.
  if (req.method === 'POST' && pathname.endsWith('/responses')) {
    const raw = await readRaw(req);
    const body = parseJson(raw);
    const model = body.model || 'mock-model';
    const text = isAudioRequest(raw) ? TRANSCRIPT_TEXT : OCR_TEXT;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_mock',
        object: 'response',
        created_at: 0,
        model,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    );
    return;
  }

  // Chat Completions API (OpenAI-compatible custom provider) — the xAI audio
  // agent lands here. Audio → transcript, anything else → OCR text.
  if (req.method === 'POST' && pathname.endsWith('/chat/completions')) {
    const raw = await readRaw(req);
    const body = parseJson(raw);
    const model = body.model || 'mock-model';
    const text = isAudioRequest(raw) ? TRANSCRIPT_TEXT : OCR_TEXT;

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
      res.write(chunk({ content: text }, null));
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
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
