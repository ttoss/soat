// Tests for tests/mocks/ollamaToolChoiceProxy.mjs — the deterministic
// `tool_choice` shim used by the smoke and tutorials compose stacks.
//
// Run: pnpm run test:harness
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

import { createToolChoiceProxy } from '../mocks/ollamaToolChoiceProxy.mjs';

const listen = (server) => {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
};

const close = (server) => {
  return new Promise((resolve) => {
    server.close(resolve);
  });
};

const ORDER_TOOL = {
  type: 'function',
  function: {
    name: 'get_order_status',
    description: 'Looks up an order in the store database.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The order ID, e.g. ord_1042',
        },
      },
      required: ['orderId'],
    },
  },
};

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Returns the weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        cityName: { type: 'string', description: 'The city name' },
      },
      required: ['cityName'],
    },
  },
};

describe('ollamaToolChoiceProxy', () => {
  /** Requests the fake upstream received, in order. */
  const upstreamRequests = [];
  let upstream;
  let upstreamUrl;
  let proxy;
  let proxyUrl;

  before(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        upstreamRequests.push({
          method: req.method,
          url: req.url,
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upstream: true, echo: body }));
      });
    });
    upstreamUrl = await listen(upstream);

    proxy = createToolChoiceProxy({
      upstreamBaseUrl: upstreamUrl,
      toolNames: ['get_order_status', 'get_weather'],
    });
    proxyUrl = await listen(proxy);
  });

  after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const chat = (body) => {
    return fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  test('synthesizes a tool call when tool_choice names a tool', async () => {
    const before = upstreamRequests.length;

    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [
        { role: 'user', content: 'What is the status of order ord_1042?' },
      ],
      tools: [ORDER_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    const call = json.choices[0].message.tool_calls[0];
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'get_order_status');
    assert.ok(call.id, 'tool call must carry an id');
    // Args come from the schema the caller authored, so the authored casing
    // survives — `orderId`, never `order_id`.
    assert.deepEqual(JSON.parse(call.function.arguments), {
      orderId: 'ord_1042',
    });
    assert.equal(json.model, 'qwen2.5:0.5b');
    assert.equal(
      upstreamRequests.length,
      before,
      'a forced call must not reach the model'
    );
  });

  test('fills an argument named in the prompt', async () => {
    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [
        {
          role: 'user',
          content: 'Call get_weather with cityName Paris. Do not answer.',
        },
      ],
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    const json = await res.json();
    const call = json.choices[0].message.tool_calls[0];
    assert.deepEqual(JSON.parse(call.function.arguments), {
      cityName: 'Paris',
    });
  });

  test('honors tool_choice "required" with a single tool', async () => {
    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Where is ord_77?' }],
      tools: [ORDER_TOOL],
      tool_choice: 'required',
    });

    const json = await res.json();
    assert.equal(
      json.choices[0].message.tool_calls[0].function.name,
      'get_order_status'
    );
  });

  test('streams the synthesized call when stream is true', async () => {
    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Status of ord_1042?' }],
      tools: [ORDER_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
      stream: true,
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"tool_calls"/);
    assert.match(text, /get_order_status/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /data: \[DONE\]/);
  });

  test('forwards a chat request with no tool_choice verbatim', async () => {
    const body = {
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const res = await chat(body);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      upstream: true,
      echo: JSON.stringify(body),
    });
    const last = upstreamRequests.at(-1);
    assert.equal(last.url, '/v1/chat/completions');
    assert.equal(last.method, 'POST');
    assert.deepEqual(JSON.parse(last.body), body);
  });

  test('forwards tool_choice values the provider can already handle', async () => {
    for (const toolChoice of ['auto', 'none']) {
      const before = upstreamRequests.length;
      await chat({
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [ORDER_TOOL],
        tool_choice: toolChoice,
      });
      assert.equal(
        upstreamRequests.length,
        before + 1,
        `tool_choice "${toolChoice}" must reach the model`
      );
    }
  });

  // Forcing is honored only for explicitly listed tools. Other CI flows force
  // tools whose arguments carry meaning the model must produce (a document id,
  // the poem text in formations.md `step_rules`, the guardrail-gated tool in the
  // smoke suite) — synthesizing those would be worse than letting the model try.
  test('forwards a forced call for a tool outside the allowlist', async () => {
    const before = upstreamRequests.length;

    await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Update the poem' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'update_document',
            parameters: {
              type: 'object',
              properties: { content: { type: 'string' } },
              required: ['content'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'update_document' } },
    });

    assert.equal(upstreamRequests.length, before + 1);
  });

  // Forcing an allowlisted tool the request does not offer is a wiring break,
  // not a model decision. Forwarding it hands the outcome back to the sandbox
  // model and revives the #774 coin flip with no trace of why.
  test('rejects a forced allowlisted tool the request does not offer', async () => {
    const before = upstreamRequests.length;

    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Status of ord_1042?' }],
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error.message, /get_order_status/);
    assert.equal(
      upstreamRequests.length,
      before,
      'a misconfigured forced call must not fall through to the model'
    );
  });

  test('rejects a forced allowlisted tool when the request offers none', async () => {
    const before = upstreamRequests.length;

    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Status of ord_1042?' }],
      tool_choice: { type: 'function', function: { name: 'get_order_status' } },
    });

    assert.equal(res.status, 400);
    assert.equal(upstreamRequests.length, before);
  });

  // The fail-closed rule keys on the *forced* name being allowlisted, so a flow
  // that forces one of its own tools keeps reaching the model even when an
  // allowlisted tool happens to be offered alongside it.
  test('forwards an unlisted forced tool offered next to an allowlisted one', async () => {
    const before = upstreamRequests.length;

    const res = await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Update the poem' }],
      tools: [
        ORDER_TOOL,
        {
          type: 'function',
          function: {
            name: 'update_document',
            parameters: {
              type: 'object',
              properties: { content: { type: 'string' } },
              required: ['content'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'update_document' } },
    });

    assert.equal(res.status, 200);
    assert.equal(upstreamRequests.length, before + 1);
  });

  test('forwards "required" when the single tool is not listed', async () => {
    const before = upstreamRequests.length;

    await chat({
      model: 'qwen2.5:0.5b',
      messages: [{ role: 'user', content: 'Do the thing' }],
      tools: [{ type: 'function', function: { name: 'update_document' } }],
      tool_choice: 'required',
    });

    assert.equal(upstreamRequests.length, before + 1);
  });

  test('forwards everything when no tool is allowlisted', async () => {
    const bare = createToolChoiceProxy({ upstreamBaseUrl: upstreamUrl });
    const bareUrl = await listen(bare);
    const before = upstreamRequests.length;

    try {
      await fetch(`${bareUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:0.5b',
          messages: [{ role: 'user', content: 'Status of ord_1042?' }],
          tools: [ORDER_TOOL],
          tool_choice: {
            type: 'function',
            function: { name: 'get_order_status' },
          },
        }),
      });

      assert.equal(upstreamRequests.length, before + 1);
    } finally {
      await close(bare);
    }
  });

  test('forwards non-chat routes such as embeddings', async () => {
    const res = await fetch(`${proxyUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-embedding:0.6b', input: 'hi' }),
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).upstream, true);
    assert.equal(upstreamRequests.at(-1).url, '/v1/embeddings');
  });

  // Output-token cap. Agents have no max_tokens field, so nothing bounds how
  // many tokens the sandbox model emits per completion — the dominant, and
  // wildly variable, cost of the smoke job. The cap is applied here, at the
  // provider boundary, exactly like the tool_choice shim above.
  describe('maxCompletionTokens', () => {
    let capped;
    let cappedUrl;

    before(async () => {
      capped = createToolChoiceProxy({
        upstreamBaseUrl: upstreamUrl,
        maxCompletionTokens: 64,
      });
      cappedUrl = await listen(capped);
    });

    after(async () => {
      await close(capped);
    });

    const cappedChat = (body) => {
      return fetch(`${cappedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    };

    test('injects max_tokens into a forwarded chat completion', async () => {
      const res = await cappedChat({
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      assert.equal(res.status, 200);
      const forwarded = JSON.parse(upstreamRequests.at(-1).body);
      assert.equal(forwarded.max_tokens, 64);
      assert.equal(forwarded.model, 'qwen2.5:0.5b');
    });

    test('lowers a caller max_tokens above the cap, keeps one below it', async () => {
      await cappedChat({
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1000,
      });
      assert.equal(JSON.parse(upstreamRequests.at(-1).body).max_tokens, 64);

      await cappedChat({
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 16,
      });
      assert.equal(JSON.parse(upstreamRequests.at(-1).body).max_tokens, 16);
    });

    test('leaves non-chat routes such as embeddings untouched', async () => {
      const body = { model: 'qwen3-embedding:0.6b', input: 'hi' };
      await fetch(`${cappedUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      assert.deepEqual(JSON.parse(upstreamRequests.at(-1).body), body);
    });

    test('without the option the body is forwarded verbatim', async () => {
      const body = {
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      await chat(body);

      assert.deepEqual(JSON.parse(upstreamRequests.at(-1).body), body);
    });
  });

  test('serves a health endpoint without touching the model', async () => {
    const before = upstreamRequests.length;
    const res = await fetch(`${proxyUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(upstreamRequests.length, before);
  });
});
