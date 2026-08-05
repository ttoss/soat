// Deterministic `tool_choice` shim in front of Ollama.
//
// Why this exists: SOAT reaches Ollama through its OpenAI-compatible endpoint
// (`buildOllamaModel` in packages/server/src/lib/agentModel.ts), and that
// endpoint does **not** implement `tool_choice` — Ollama's compatibility docs
// list the field as unsupported, so it is silently dropped. An agent configured
// with `tool_choice: {type:'tool', tool_name:'x'}` therefore gets no forcing at
// all in CI: whether the run pauses on a client tool depends on whether
// `qwen2.5:0.5b` volunteers a tool call, which it does only sometimes. That is
// the flake behind issue #774 — it failed a release pipeline, not a code change.
//
// This proxy implements exactly the missing field, for an explicit allowlist of
// tools (`TOOL_CHOICE_TOOLS`), and nothing else:
//
//   * `POST **/chat/completions` forcing an **allowlisted** tool → a synthesized
//     OpenAI-shaped `tool_calls` response. The model is never called, so the
//     forced call is deterministic.
//   * everything else — an unlisted tool, no `tool_choice`, `"auto"`, `"none"`,
//     `/v1/embeddings`, any other route — is forwarded to Ollama verbatim.
//
// The allowlist keeps the blast radius at one step per suite. Other CI flows
// force tools whose arguments only the model can fill (the guardrail-gated tool
// in the smoke suite, `step_rules` forcing in the formations tutorial), and
// those keep running against the real model exactly as they do today.
// Tool-call arguments are built from the caller-authored JSON Schema, which is
// also what keeps authored key casing (`orderId`, `cityName`) intact.
//
// Used by tests/docker-compose.tutorials.yml and tests/docker-compose.smoke.yml
// as OLLAMA_BASE_URL. Tested by tests/harness/ollamaToolChoiceProxy.test.mjs.
import { createServer } from 'node:http';

const CHAT_COMPLETIONS_PATH = /\/chat\/completions$/;

const readBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
};

/** The text of the last user message, whatever content shape it uses. */
const lastUserText = (messages) => {
  const userMessages = (Array.isArray(messages) ? messages : []).filter(
    (message) => {
      return message?.role === 'user';
    }
  );
  const content = userMessages.at(-1)?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        return typeof part === 'string' ? part : (part?.text ?? '');
      })
      .join(' ');
  }
  return '';
};

const stripTrailingPunctuation = (value) => {
  return value.replace(/[.,!?;:]+$/, '');
};

/**
 * Picks a plausible value for one schema property from the prompt.
 *
 * The tests assert only structure and key casing, so the value is cosmetic —
 * but a value lifted from the prompt keeps the output printed in a tutorial
 * honest (`ord_1042`, not a placeholder).
 */
const inferStringArgument = (args) => {
  const { name, description, text } = args;

  const named = text.match(
    new RegExp(`${name}\\s*(?:is|=|:)?\\s*"?([\\w.\\-/]+)"?`, 'i')
  );
  if (named?.[1]) {
    return stripTrailingPunctuation(named[1]);
  }

  const example = String(description ?? '').match(/e\.g\.\s*"?([\w.\-/]+)"?/i);
  if (example?.[1]) {
    return stripTrailingPunctuation(example[1]);
  }

  const idLike = text.match(/\b[a-z][a-z0-9]*_[A-Za-z0-9-]+\b/);
  if (idLike?.[0]) {
    return idLike[0];
  }

  const quoted = text.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) {
    return quoted[1] ?? quoted[2];
  }

  return 'unknown';
};

const inferArgument = (args) => {
  const { schema, name, text } = args;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  switch (schema?.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return inferStringArgument({
        name,
        description: schema?.description,
        text,
      });
  }
};

/** Builds arguments for every required property of the forced tool. */
const buildToolArguments = (args) => {
  const { parameters, text } = args;
  const properties = parameters?.properties ?? {};
  const required = Array.isArray(parameters?.required)
    ? parameters.required
    : Object.keys(properties);

  return Object.fromEntries(
    required
      .filter((name) => {
        return name in properties;
      })
      .map((name) => {
        return [name, inferArgument({ schema: properties[name], name, text })];
      })
  );
};

/**
 * Resolves which tool the request forces, or null when the request should go to
 * the model untouched.
 *
 * `toolNames` is an allowlist, and it is deliberately narrow. Other CI flows
 * force tools whose arguments carry meaning only the model can supply — the
 * guardrail-gated tool in the smoke suite, the per-step `step_rules` forcing in
 * the formations tutorial (document ids, the poem text). Synthesizing those
 * would be worse than the status quo, so a tool that is not listed keeps going
 * to the real model exactly as it does today.
 */
const resolveForcedTool = (args) => {
  const { body, toolNames } = args;
  const toolChoice = body?.tool_choice;
  if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none') {
    return null;
  }

  const tools = (Array.isArray(body?.tools) ? body.tools : []).filter(
    (tool) => {
      return tool?.function?.name && toolNames.has(tool.function.name);
    }
  );
  if (tools.length === 0) {
    return null;
  }

  if (toolChoice === 'required') {
    // "required" names no tool, so it is only unambiguous when the request
    // offers exactly one — and that one has to be allowlisted.
    const offered = Array.isArray(body.tools) ? body.tools.length : 0;
    return offered === 1 ? tools[0].function : null;
  }

  if (typeof toolChoice === 'object') {
    // OpenAI wire shape is {type:'function', function:{name}}; accept the
    // SOAT-facing {type:'tool', tool_name} spelling too so the shim keeps
    // working if the provider layer changes how it serializes the field.
    const name =
      toolChoice.function?.name ?? toolChoice.tool_name ?? toolChoice.toolName;
    const match = tools.find((tool) => {
      return tool.function.name === name;
    });
    return match?.function ?? null;
  }

  return null;
};

const randomId = (prefix) => {
  return `${prefix}${Math.random().toString(36).slice(2, 12)}`;
};

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const sendForcedToolCall = (args) => {
  const { res, body, forcedTool } = args;
  const toolCall = {
    id: randomId('call_'),
    type: 'function',
    function: {
      name: forcedTool.name,
      arguments: JSON.stringify(
        buildToolArguments({
          parameters: forcedTool.parameters,
          text: lastUserText(body.messages),
        })
      ),
    },
  };
  const created = Math.floor(Date.now() / 1000);
  const id = randomId('chatcmpl-');
  const model = body.model ?? 'tool-choice-proxy';
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (!body.stream) {
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [toolCall] },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta, finishReason) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      })}\n\n`
    );
  };
  chunk({ role: 'assistant' });
  chunk({ tool_calls: [{ index: 0, ...toolCall }] });
  chunk({}, 'tool_calls');
  res.write(
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
};

const forward = async (args) => {
  const { req, res, body, upstreamBaseUrl } = args;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;

  const upstream = await fetch(`${upstreamBaseUrl}${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    duplex: 'half',
  });

  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (key !== 'content-encoding' && key !== 'transfer-encoding') {
      responseHeaders[key] = value;
    }
  });
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) {
    res.write(chunk);
  }
  res.end();
};

/**
 * Creates the proxy server.
 *
 * - `upstreamBaseUrl` — the real Ollama origin, e.g. `http://ollama:11434`. The
 *   OpenAI-compatible routes live under `/v1` there, and the incoming path is
 *   preserved as-is when forwarding.
 * - `toolNames` — tools whose forcing is honored deterministically. Anything not
 *   listed goes to the model untouched, so the default (no list) is a pure
 *   pass-through proxy.
 * - `maxCompletionTokens` — optional output-token cap injected as `max_tokens`
 *   into every forwarded chat completion (a caller-set value below the cap is
 *   kept). Unset = bodies are forwarded verbatim.
 */
export const createToolChoiceProxy = (args) => {
  const { upstreamBaseUrl, maxCompletionTokens } = args;
  const toolNames = new Set(args.toolNames ?? []);

  return createServer((req, res) => {
    (async () => {
      const url = req.url ?? '/';

      if (url === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      const rawBody = await readBody(req);

      if (
        req.method !== 'POST' ||
        !CHAT_COMPLETIONS_PATH.test(url.split('?')[0])
      ) {
        await forward({ req, res, body: rawBody, upstreamBaseUrl });
        return;
      }

      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        await forward({ req, res, body: rawBody, upstreamBaseUrl });
        return;
      }

      const forcedTool = resolveForcedTool({ body, toolNames });
      if (!forcedTool) {
        // Agents carry no max_tokens field, so nothing else bounds how many
        // tokens the model emits per completion — the dominant, and wildly
        // variable, cost of the CI suites. Cap it here, at the provider
        // boundary; a caller-set value below the cap is respected.
        if (maxCompletionTokens) {
          body.max_tokens = Math.min(
            body.max_tokens ?? maxCompletionTokens,
            maxCompletionTokens
          );
          await forward({
            req,
            res,
            body: Buffer.from(JSON.stringify(body)),
            upstreamBaseUrl,
          });
          return;
        }
        await forward({ req, res, body: rawBody, upstreamBaseUrl });
        return;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[tool-choice-proxy] forcing ${forcedTool.name} (model=${body.model})`
      );
      sendForcedToolCall({ res, body, forcedTool });
    })().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[tool-choice-proxy] error', error);
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: String(error) } });
        return;
      }
      res.end();
    });
  });
};

const isMain = process.argv[1] === new URL(import.meta.url).pathname;

if (isMain) {
  const port = Number(process.env.PORT ?? 11434);
  const upstreamBaseUrl = process.env.OLLAMA_UPSTREAM_URL;
  // Comma-separated tool names whose forcing is honored, e.g.
  // TOOL_CHOICE_TOOLS='get_order_status,get_weather'. Unset = pass-through only.
  const toolNames = (process.env.TOOL_CHOICE_TOOLS ?? '')
    .split(',')
    .map((name) => {
      return name.trim();
    })
    .filter(Boolean);
  // Output-token cap injected into every forwarded chat completion, e.g.
  // MAX_COMPLETION_TOKENS=256. Unset = no cap.
  const maxCompletionTokens =
    Number(process.env.MAX_COMPLETION_TOKENS) || undefined;
  if (!upstreamBaseUrl) {
    // eslint-disable-next-line no-console
    console.error('OLLAMA_UPSTREAM_URL is required');
    process.exit(1);
  }
  createToolChoiceProxy({
    upstreamBaseUrl,
    toolNames,
    maxCompletionTokens,
  }).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[tool-choice-proxy] listening on :${port} → ${upstreamBaseUrl} ` +
        `(forcing: ${toolNames.join(', ') || 'none'}; ` +
        `max_tokens cap: ${maxCompletionTokens ?? 'none'})`
    );
  });
}
