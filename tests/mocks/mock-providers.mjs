#!/usr/bin/env node
// Deterministic mock provider endpoints for the `ingest-images-and-audio`
// tutorial, so the converter flow can be validated in the tutorials runner
// without external API keys — and *correctly*, by checking the bytes the
// tutorial actually sent against the fixture files checked into the repo
// (packages/website/docs/tutorials/fixtures/), not just returning canned
// text regardless of input.
//
// The tutorial demonstrates the two converter kinds side by side:
//   * images → an **agent** converter (native `openai` provider → Responses
//     API). Mocked at POST /v1/responses: extracts the base64 image embedded
//     in the request's `input_image` part and compares it byte-for-byte
//     against fixtures/receipt.png.
//   * audio  → a **tool** converter (a plain `http` tool calling a real,
//     non-chat STT REST API directly, `body_mode: multipart`). Mocked at
//     POST /v1/stt: parses the multipart/form-data body, extracts the `file`
//     part, and compares it byte-for-byte against fixtures/meeting.mp3.
//
// Either mismatch responds with an error instead of the canned success text,
// so a tutorial regression (wrong fixture, broken base64, wrong field name)
// fails the CI run loudly instead of silently passing.
//
//   GET  /health        — readiness probe for docker-compose.
//   POST /v1/responses  — Responses API (native OpenAI provider, image OCR).
//   POST /v1/stt        — xAI-shaped speech-to-text REST endpoint (audio tool).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8090);
const FIXTURES_DIR = process.env.FIXTURES_DIR || '/fixtures';

// Canned content — kept searchable so the tutorial's knowledge queries hit.
const OCR_TEXT = 'Corner Cafe\nCoffee 3.50\nSandwich 8.00\nTotal amount: 11.50';
const TRANSCRIPT_TEXT = 'Launch is next Tuesday.';

const receiptFixture = fs.readFileSync(path.join(FIXTURES_DIR, 'receipt.png'));
const meetingFixture = fs.readFileSync(path.join(FIXTURES_DIR, 'meeting.mp3'));

const readRawBuffer = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const parseJson = (raw) => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const jsonError = (res, status, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
};

// Extracts the base64 payload from an AI SDK `input_image` data URL
// (`"image_url":"data:image/png;base64,...."`) embedded in the raw JSON body.
const extractImageBase64 = (raw) => {
  const match = raw.match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/);
  return match ? match[1] : null;
};

// Minimal RFC 2046 multipart/form-data parser — enough to pull named parts
// (and their raw binary bodies) out of a real `http` tool's multipart
// request. No third-party dependency needed for this.
const parseMultipart = (buffer, boundary) => {
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(boundaryMarker);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryMarker, start + boundaryMarker.length);
    if (next === -1) break;
    parts.push(buffer.subarray(start + boundaryMarker.length, next));
    start = next;
  }
  return parts
    .map((part) => {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) return null;
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      let body = part.subarray(headerEnd + 4);
      if (body.subarray(-2).toString('utf8') === '\r\n') {
        body = body.subarray(0, -2);
      }
      const nameMatch = headerText.match(/name="([^"]+)"/);
      const filenameMatch = headerText.match(/filename="([^"]+)"/);
      return {
        name: nameMatch?.[1],
        filename: filenameMatch?.[1],
        body,
      };
    })
    .filter(Boolean);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Responses API (native OpenAI provider) — the vision OCR agent lands here.
  // Validates the embedded image against fixtures/receipt.png before
  // returning the canned OCR text.
  if (req.method === 'POST' && pathname.endsWith('/responses')) {
    const raw = (await readRawBuffer(req)).toString('utf8');
    const body = parseJson(raw);
    const model = body.model || 'mock-model';

    const imageBase64 = extractImageBase64(raw);
    if (!imageBase64) {
      jsonError(res, 400, 'expected an input_image data URL in the request');
      return;
    }
    if (!Buffer.from(imageBase64, 'base64').equals(receiptFixture)) {
      jsonError(
        res,
        422,
        'uploaded image does not match fixtures/receipt.png — tutorial sent the wrong bytes'
      );
      return;
    }

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
            content: [{ type: 'output_text', text: OCR_TEXT, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    );
    return;
  }

  // xAI-shaped speech-to-text REST endpoint — the audio *tool* converter
  // (an `http` tool with `body_mode: multipart`) lands here directly, no
  // agent/LLM wire protocol involved. Validates the uploaded file against
  // fixtures/meeting.mp3 before returning the canned transcript.
  if (req.method === 'POST' && pathname.endsWith('/stt')) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
    if (!boundary) {
      jsonError(res, 400, 'expected multipart/form-data with a boundary');
      return;
    }

    const raw = await readRawBuffer(req);
    const parts = parseMultipart(raw, boundary);
    const filePart = parts.find((part) => part.name === 'file');
    if (!filePart) {
      jsonError(res, 400, 'expected a multipart "file" field');
      return;
    }
    if (!filePart.body.equals(meetingFixture)) {
      jsonError(
        res,
        422,
        'uploaded audio does not match fixtures/meeting.mp3 — tutorial sent the wrong bytes'
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        text: TRANSCRIPT_TEXT,
        language: 'en',
        duration: 1.4,
        words: TRANSCRIPT_TEXT.split(' ').map((word, i) => ({
          text: word,
          start: i * 0.3,
          end: i * 0.3 + 0.25,
        })),
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
